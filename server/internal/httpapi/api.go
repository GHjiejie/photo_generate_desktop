// Package httpapi exposes the portrait store to a native client through a local
// TLS reverse proxy or authenticated SSH tunnel. Platform sessions are required.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"portraitstudio/server/internal/auth"
	"portraitstudio/server/internal/store"
)

type Backend interface {
	List() (store.Snapshot, error)
	Get(int) (store.Item, int64, error)
	ReadImage(int) (store.ImageResult, error)
	Create(store.CreateInput) (store.MutationResult, error)
	Update(store.UpdateInput) (store.MutationResult, error)
	Delete(store.DeleteInput) (store.MutationResult, error)
	PreviewBatch(store.BatchInput) (store.BatchPreview, error)
	CommitBatch(store.CommitBatchInput) (store.BatchResult, error)
	CancelBatch(string) error
}

type Options struct {
	Version      string
	LibraryLabel string
	TempDir      string
	Auth         *auth.Manager
}

type API struct {
	backend Backend
	options Options
	uploads chan struct{}
}

func New(backend Backend, options Options) *API {
	if options.LibraryLabel == "" {
		options.LibraryLabel = "Remote portrait library"
	}
	if options.Version == "" {
		options.Version = "development"
	}
	return &API{backend: backend, options: options, uploads: make(chan struct{}, 2)}
}

type response struct {
	OK    bool         `json:"ok"`
	Data  any          `json:"data,omitempty"`
	Error *store.Error `json:"error,omitempty"`
}

func reply(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response{OK: true, Data: data})
}
func errorReply(w http.ResponseWriter, err error) {
	var authError *auth.Error
	if errors.As(err, &authError) {
		err = problem(authError.Code, authError.Message)
	}
	code := store.ErrorCode(err)
	status := http.StatusBadRequest
	switch code {
	case "NOT_FOUND", "INVALID_BATCH_SELECTION", "PREVIEW_EXPIRED":
		status = http.StatusNotFound
	case "CONFLICT", "DUPLICATE_ID", "LOCKED":
		status = http.StatusConflict
	case "FORBIDDEN":
		status = http.StatusForbidden
	case "TOO_LARGE", "IMAGE_TOO_LARGE", "DIRECTORY_TOO_LARGE", "TOO_MANY_RECORDS":
		status = http.StatusRequestEntityTooLarge
	case "UNAVAILABLE":
		status = http.StatusServiceUnavailable
	case "ABORTED":
		status = http.StatusRequestTimeout
	case "METHOD_NOT_ALLOWED":
		status = http.StatusMethodNotAllowed
	case "AUTH_REQUIRED", "SESSION_EXPIRED", "AUTH_NOT_INITIALIZED", "INVALID_CREDENTIALS":
		status = http.StatusUnauthorized
		w.Header().Set("WWW-Authenticate", `Bearer realm="Portrait Studio"`)
	case "AUTH_RATE_LIMITED":
		status = http.StatusTooManyRequests
		w.Header().Set("Retry-After", "60")
	case "AUTH_UNAVAILABLE":
		status = http.StatusServiceUnavailable
	case "IO_ERROR", "NO_PERMISSION":
		status = http.StatusInternalServerError
	}
	var typed *store.Error
	message := "The operation failed."
	if errors.As(err, &typed) {
		message = typed.Message
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response{Error: &store.Error{Code: code, Message: message}})
}
func problem(code, message string) error { return &store.Error{Code: code, Message: message} }
func canceled(ctx context.Context) error {
	if ctx.Err() != nil {
		return problem("ABORTED", "The request was canceled before a library change was committed.")
	}
	return nil
}

func loopbackHost(value string) bool {
	if strings.ContainsAny(value, "\\/@ \t\r\n") || value == "" {
		return false
	}
	host := value
	if parsed, port, err := net.SplitHostPort(value); err == nil {
		host = parsed
		if p, e := strconv.Atoi(port); e != nil || p < 1 || p > 65535 {
			return false
		}
	} else if strings.Contains(value, ":") {
		return false
	}
	return host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}

// LoopbackAddress rejects wildcard and non-loopback listeners. Platform
// authentication is still required for requests arriving through a proxy/tunnel.
func LoopbackAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("listen address must include a loopback IP and port")
	}
	ip := net.ParseIP(host)
	p, parseErr := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || parseErr != nil || p < 1 || p > 65535 {
		return fmt.Errorf("the HTTP service must listen on a loopback IP; use a TLS reverse proxy or authenticated SSH tunnel")
	}
	return nil
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(remote) == nil || !net.ParseIP(remote).IsLoopback() || !loopbackHost(r.Host) || r.Header.Get("Origin") != "" {
		errorReply(w, problem("FORBIDDEN", "This service accepts native requests through its local proxy or tunnel only."))
		return
	}
	if r.URL.RawPath != "" || strings.Contains(r.URL.Path, "%") || strings.Contains(r.URL.Path, "//") || r.URL.Fragment != "" {
		errorReply(w, problem("INVALID_INPUT", "The route is invalid."))
		return
	}
	if r.Method == http.MethodGet && (r.ContentLength > 0 || len(r.TransferEncoding) > 0) {
		errorReply(w, problem("INVALID_INPUT", "Read-only routes do not accept a request body."))
		return
	}
	if r.URL.Path != "/v1/images/" && !strings.HasPrefix(r.URL.Path, "/v1/images/") && r.URL.RawQuery != "" {
		errorReply(w, problem("INVALID_INPUT", "This route does not accept query parameters."))
		return
	}
	deadline := 30 * time.Second
	if r.Method == http.MethodPost && r.URL.Path == "/v1/batches/preview" {
		deadline = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	r = r.WithContext(ctx)
	if err := canceled(ctx); err != nil {
		errorReply(w, err)
		return
	}
	// Authenticate before parsing a request body or staging an upload. Missing
	// configuration, and an accidentally nil manager, both fail closed.
	public := r.URL.Path == "/healthz" || r.URL.Path == "/v1/auth/status" || r.URL.Path == "/v1/auth/login"
	var token string
	var session auth.Session
	if !public {
		if !a.options.Auth.Initialized() {
			errorReply(w, problem("AUTH_NOT_INITIALIZED", "The admin password has not been initialized by the server owner."))
			return
		}
		token, err = bearerToken(r)
		if err == nil {
			session, err = a.options.Auth.Validate(token)
		}
		if err != nil {
			errorReply(w, err)
			return
		}
	}
	var result any
	switch {
	case r.URL.Path == "/healthz":
		if r.Method != http.MethodGet {
			a.method(w, "GET")
			return
		}
		result = map[string]any{"status": "ok", "version": a.options.Version}
	case r.URL.Path == "/v1/auth/status":
		if r.Method != http.MethodGet {
			a.method(w, "GET")
			return
		}
		result = map[string]any{"initialized": a.options.Auth.Initialized(), "authenticated": false}
	case r.URL.Path == "/v1/auth/login":
		if r.Method != http.MethodPost {
			a.method(w, "POST")
			return
		}
		var input map[string]json.RawMessage
		if err = readJSONBody(w, r, &input, 4096); err == nil {
			username, password, inputErr := loginFields(input)
			if inputErr != nil {
				err = inputErr
				break
			}
			result, err = a.options.Auth.Login(username, password)
			auth.Erase(password)
		}
	case r.URL.Path == "/v1/auth/session":
		switch r.Method {
		case http.MethodGet:
			result = session
		case http.MethodDelete:
			if r.ContentLength != 0 || len(r.TransferEncoding) > 0 {
				err = problem("INVALID_INPUT", "Logout does not accept a request body.")
				break
			}
			err = a.options.Auth.Logout(token)
			result = map[string]any{"loggedOut": true}
		default:
			a.method(w, "GET, DELETE")
			return
		}
	case r.URL.Path == "/v1/library":
		if r.Method != http.MethodGet {
			a.method(w, "GET")
			return
		}
		result, err = a.snapshot()
	case r.URL.Path == "/v1/portraits":
		if r.Method != http.MethodPost {
			a.method(w, "POST")
			return
		}
		result, err = a.create(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/portraits/"):
		var id int
		id, err = parseID(strings.TrimPrefix(r.URL.Path, "/v1/portraits/"))
		if err == nil {
			result, err = a.portrait(w, r, id)
		}
	case strings.HasPrefix(r.URL.Path, "/v1/images/"):
		if r.Method != http.MethodGet {
			a.method(w, "GET")
			return
		}
		var id int
		id, err = parseID(strings.TrimPrefix(r.URL.Path, "/v1/images/"))
		if err == nil {
			err = a.image(w, r, id)
			if err == nil {
				return
			}
		}
	case r.URL.Path == "/v1/batches/preview":
		if r.Method != http.MethodPost {
			a.method(w, "POST")
			return
		}
		result, err = a.preview(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/batches/"):
		result, err = a.batch(w, r, strings.TrimPrefix(r.URL.Path, "/v1/batches/"))
	default:
		err = problem("NOT_FOUND", "The requested API route does not exist.")
	}
	if errors.Is(err, errResponseWritten) {
		return
	}
	if err != nil {
		errorReply(w, err)
		return
	}
	reply(w, http.StatusOK, result)
}

func bearerToken(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") || len(values[0]) != len("Bearer ")+43 {
		return "", problem("AUTH_REQUIRED", "Sign in to access the portrait library.")
	}
	return strings.TrimPrefix(values[0], "Bearer "), nil
}

func loginFields(input map[string]json.RawMessage) (string, []byte, error) {
	if len(input) != 2 || input["username"] == nil || input["password"] == nil {
		return "", nil, problem("INVALID_INPUT", "Sign-in requires only username and password fields.")
	}
	var username, password string
	if len(input["username"]) == 0 || input["username"][0] != '"' || len(input["password"]) == 0 || input["password"][0] != '"' || json.Unmarshal(input["username"], &username) != nil || json.Unmarshal(input["password"], &password) != nil {
		return "", nil, problem("INVALID_INPUT", "Sign-in fields must be strings.")
	}
	return username, []byte(password), nil
}

func (a *API) method(w http.ResponseWriter, methods string) {
	w.Header().Set("Allow", methods)
	errorReply(w, problem("METHOD_NOT_ALLOWED", "The request method is not supported on this route."))
}
func parseID(value string) (int, error) {
	id, err := strconv.Atoi(value)
	if err != nil || id < 1 || id > 999999 || strconv.Itoa(id) != value {
		return 0, problem("INVALID_INPUT", "A portrait ID must be an integer from 1 to 999999.")
	}
	return id, nil
}

type publicItem struct {
	store.Item
	ImageURL string `json:"image_url"`
}

func project(item store.Item) publicItem {
	return publicItem{Item: item, ImageURL: fmt.Sprintf("/v1/images/%d?revision=%d", item.ID, item.Revision)}
}
func (a *API) snapshot() (any, error) {
	snapshot, err := a.backend.List()
	if err != nil {
		return nil, err
	}
	items := make([]publicItem, 0, len(snapshot.Items))
	for _, item := range snapshot.Items {
		items = append(items, project(item))
	}
	return map[string]any{"configured": true, "root": a.options.LibraryLabel, "writable": true, "revision": snapshot.Revision, "items": items}, nil
}
func (a *API) mutation(result store.MutationResult, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	snapshot, err := a.snapshot()
	if err != nil {
		return nil, err
	}
	out := map[string]any{"snapshot": snapshot, "revision": result.Revision}
	if result.Item != nil {
		out["item"] = project(*result.Item)
	}
	if result.DeletedID != 0 {
		out["deletedId"] = result.DeletedID
	}
	if result.RecoveryID != "" {
		out["recoveryId"] = result.RecoveryID
	}
	return out, nil
}
func (a *API) create(w http.ResponseWriter, r *http.Request) (any, error) {
	metadata, image, err := a.readMutation(w, r, true)
	if err != nil {
		return nil, err
	}
	var input store.CreateInput
	if err = decodeStrict(metadata, &input); err != nil {
		return nil, err
	}
	input.Image = image
	input.Context = r.Context()
	if err = canceled(r.Context()); err != nil {
		return nil, err
	}
	return a.mutation(a.backend.Create(input))
}
func (a *API) portrait(w http.ResponseWriter, r *http.Request, id int) (any, error) {
	switch r.Method {
	case http.MethodGet:
		item, revision, err := a.backend.Get(id)
		if err != nil {
			return nil, err
		}
		return map[string]any{"revision": revision, "item": project(item)}, nil
	case http.MethodPatch:
		metadata, image, err := a.readMutation(w, r, false)
		if err != nil {
			return nil, err
		}
		var input store.UpdateInput
		if err = decodeStrict(metadata, &input); err != nil {
			return nil, err
		}
		if input.ID != id {
			return nil, problem("INVALID_INPUT", "The route ID and metadata ID must match.")
		}
		input.Image = image
		input.Context = r.Context()
		if err = canceled(r.Context()); err != nil {
			return nil, err
		}
		return a.mutation(a.backend.Update(input))
	case http.MethodDelete:
		var input store.DeleteInput
		if err := readJSONBody(w, r, &input, 256<<10); err != nil {
			return nil, err
		}
		if input.ID != id {
			return nil, problem("INVALID_INPUT", "The route ID and metadata ID must match.")
		}
		if err := canceled(r.Context()); err != nil {
			return nil, err
		}
		input.Context = r.Context()
		return a.mutation(a.backend.Delete(input))
	default:
		a.method(w, "GET, PATCH, DELETE")
		return nil, errResponseWritten
	}
}

var errResponseWritten = errors.New("response already written")

func (a *API) image(w http.ResponseWriter, r *http.Request, id int) error {
	query, err := decodeQuery(r.URL.RawQuery)
	if err != nil {
		return err
	}
	values, exists := query["revision"]
	if !exists || len(query) != 1 || len(values) != 1 {
		return problem("INVALID_INPUT", "An image request requires exactly one revision.")
	}
	revision, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || revision < 1 || strconv.FormatInt(revision, 10) != values[0] {
		return problem("INVALID_INPUT", "The image revision is invalid.")
	}
	image, err := a.backend.ReadImage(id)
	if err != nil {
		return err
	}
	if image.Revision != revision {
		return problem("CONFLICT", "The image has changed; refresh the library.")
	}
	w.Header().Set("Content-Type", image.MIME)
	w.Header().Set("Content-Length", strconv.Itoa(len(image.Bytes)))
	w.Header().Set("ETag", `"`+image.SHA256+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(image.Bytes)
	return nil
}

func (a *API) batch(w http.ResponseWriter, r *http.Request, path string) (any, error) {
	parts := strings.Split(path, "/")
	if len(parts) > 2 || !validUUID(parts[0]) {
		return nil, problem("INVALID_BATCH_SELECTION", "The batch preview identifier is invalid.")
	}
	id := parts[0]
	if len(parts) == 2 && parts[1] == "commit" {
		if r.Method != http.MethodPost {
			a.method(w, "POST")
			return nil, errResponseWritten
		}
		var payload struct {
			ExpectedVersion int64 `json:"expectedVersion"`
			Confirmed       bool  `json:"confirmed"`
		}
		if err := readJSONBody(w, r, &payload, 256<<10); err != nil {
			return nil, err
		}
		if err := canceled(r.Context()); err != nil {
			return nil, err
		}
		result, err := a.backend.CommitBatch(store.CommitBatchInput{Context: r.Context(), PreviewID: id, ExpectedVersion: payload.ExpectedVersion, Confirmed: payload.Confirmed})
		if err != nil {
			return nil, err
		}
		snapshot, err := a.snapshot()
		if err != nil {
			return nil, err
		}
		return map[string]any{"snapshot": snapshot, "report": map[string]any{"revision": result.Revision, "imported": result.Imported, "skipped": result.Skipped, "conflicts": result.Counts.Conflicts, "invalid": result.Counts.Errors, "archiveRel": result.ArchiveRel, "mapping": result.Items, "counts": result.Counts}}, nil
	}
	if len(parts) != 1 {
		return nil, problem("NOT_FOUND", "The requested batch route does not exist.")
	}
	if r.Method != http.MethodDelete {
		a.method(w, "DELETE")
		return nil, errResponseWritten
	}
	if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
		return nil, problem("INVALID_INPUT", "Cancel does not accept a request body.")
	}
	if err := a.backend.CancelBatch(id); err != nil {
		return nil, err
	}
	return map[string]any{"cancelled": true}, nil
}

func (a *API) reserve(ctx context.Context) error {
	select {
	case a.uploads <- struct{}{}:
		return nil
	case <-ctx.Done():
		return problem("ABORTED", "Upload was canceled.")
	default:
		return problem("UNAVAILABLE", "Two uploads are already in progress; retry shortly.")
	}
}
func (a *API) uploadDirectory() (string, error) {
	directory, err := os.MkdirTemp(a.options.TempDir, "portrait-upload-")
	if err != nil {
		return "", problem("IO_ERROR", "Could not create an upload staging directory.")
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		_ = os.RemoveAll(directory)
		return "", problem("IO_ERROR", "Could not resolve the upload staging directory.")
	}
	return canonical, nil
}

func contentType(r *http.Request, want string) error {
	value, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || value != want {
		return problem("INVALID_INPUT", "The request Content-Type is unsupported.")
	}
	return nil
}
