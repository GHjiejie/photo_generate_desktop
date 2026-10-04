package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"portraitstudio/server/internal/auth"
	"portraitstudio/server/internal/store"
)

type authBoundaryBackend struct{ called bool }

func (b *authBoundaryBackend) List() (store.Snapshot, error) {
	b.called = true
	return store.Snapshot{}, nil
}
func (b *authBoundaryBackend) Get(int) (store.Item, int64, error) {
	b.called = true
	return store.Item{}, 0, nil
}
func (b *authBoundaryBackend) ReadImage(int) (store.ImageResult, error) {
	b.called = true
	return store.ImageResult{}, nil
}
func (b *authBoundaryBackend) Create(store.CreateInput) (store.MutationResult, error) {
	b.called = true
	return store.MutationResult{}, nil
}
func (b *authBoundaryBackend) Update(store.UpdateInput) (store.MutationResult, error) {
	b.called = true
	return store.MutationResult{}, nil
}
func (b *authBoundaryBackend) Delete(store.DeleteInput) (store.MutationResult, error) {
	b.called = true
	return store.MutationResult{}, nil
}
func (b *authBoundaryBackend) PreviewBatch(store.BatchInput) (store.BatchPreview, error) {
	b.called = true
	return store.BatchPreview{}, nil
}
func (b *authBoundaryBackend) CommitBatch(store.CommitBatchInput) (store.BatchResult, error) {
	b.called = true
	return store.BatchResult{}, nil
}
func (b *authBoundaryBackend) CancelBatch(string) error { b.called = true; return nil }

type unreadAuthBody struct{ read bool }

func (b *unreadAuthBody) Read([]byte) (int, error) { b.read = true; return 0, io.ErrUnexpectedEOF }
func (b *unreadAuthBody) Close() error             { return nil }
func authFixture(t *testing.T, now func() time.Time) *auth.Manager {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "admin-auth.json")
	if err = auth.Initialize(path, []byte("Isolated API fixture 2026!")); err != nil {
		t.Fatal(err)
	}
	manager, err := auth.Open(path, auth.Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	return manager
}
func authRequest(t *testing.T, api *API, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:4137"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	return w
}

func TestAuthBoundaryCoversAllLibraryRoutesBeforeBodiesAndBackend(t *testing.T) {
	manager := authFixture(t, nil)
	for _, mode := range []struct {
		name    string
		manager *auth.Manager
		code    string
	}{{"initialized", manager, "AUTH_REQUIRED"}, {"nil", nil, "AUTH_NOT_INITIALIZED"}} {
		for _, route := range []struct{ method, path string }{{"GET", "/v1/library"}, {"POST", "/v1/portraits"}, {"GET", "/v1/portraits/1"}, {"PATCH", "/v1/portraits/1"}, {"DELETE", "/v1/portraits/1"}, {"GET", "/v1/images/1?revision=1"}, {"POST", "/v1/batches/preview"}, {"POST", "/v1/batches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/commit"}, {"DELETE", "/v1/batches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}, {"GET", "/v1/auth/session"}, {"DELETE", "/v1/auth/session"}} {
			t.Run(mode.name+"-"+route.method+"-"+route.path, func(t *testing.T) {
				backend := &authBoundaryBackend{}
				stage := t.TempDir()
				api := New(backend, Options{Auth: mode.manager, TempDir: stage})
				r := httptest.NewRequest(route.method, "http://127.0.0.1:4137"+route.path, nil)
				r.RemoteAddr = "127.0.0.1:50000"
				body := &unreadAuthBody{}
				r.Body = body
				r.ContentLength = -1
				r.Header.Set("Content-Type", "multipart/form-data; boundary=unused")
				w := httptest.NewRecorder()
				api.ServeHTTP(w, r)
				if w.Code != 401 || errorCode(t, w) != mode.code || backend.called || body.read {
					t.Fatal("authentication allowed body/backend work")
				}
				entries, _ := os.ReadDir(stage)
				if len(entries) != 0 {
					t.Fatal("unauthorized upload was staged")
				}
			})
		}
	}
}

func TestPublicAuthStatusLoginSessionAndLogout(t *testing.T) {
	now := time.Now()
	manager := authFixture(t, func() time.Time { return now })
	backend := &authBoundaryBackend{}
	api := New(backend, Options{Auth: manager})
	for _, path := range []string{"/healthz", "/v1/auth/status"} {
		data := success(t, authRequest(t, api, "GET", path, "", ""))
		if bytes.Contains(data, []byte("items")) || bytes.Contains(data, []byte("hash")) || bytes.Contains(data, []byte("sessionToken")) {
			t.Fatal("public endpoint disclosed private information")
		}
	}
	status := success(t, authRequest(t, api, "GET", "/v1/auth/status", "", ""))
	if string(status) != `{"authenticated":false,"initialized":true}` {
		t.Fatal("unexpected public auth status")
	}
	login := authRequest(t, api, "POST", "/v1/auth/login", "", `{"username":"admin","password":"Isolated API fixture 2026!"}`)
	var credentials auth.LoginResult
	if json.Unmarshal(success(t, login), &credentials) != nil || len(credentials.SessionToken) != 43 || credentials.Username != "admin" {
		t.Fatal("login contract failed")
	}
	if login.Header().Get("Cache-Control") != "no-store" || backend.called {
		t.Fatal("login leaked/called library")
	}
	session := success(t, authRequest(t, api, "GET", "/v1/auth/session", credentials.SessionToken, ""))
	if bytes.Contains(session, []byte(credentials.SessionToken)) {
		t.Fatal("session endpoint returned bearer secret")
	}
	success(t, authRequest(t, api, "GET", "/v1/library", credentials.SessionToken, ""))
	if !backend.called {
		t.Fatal("authenticated library did not run")
	}
	success(t, authRequest(t, api, "DELETE", "/v1/auth/session", credentials.SessionToken, ""))
	w := authRequest(t, api, "GET", "/v1/library", credentials.SessionToken, "")
	if w.Code != 401 || errorCode(t, w) != "AUTH_REQUIRED" {
		t.Fatal("logout retained API access")
	}
	credentials, err := manager.Login("admin", []byte("Isolated API fixture 2026!"))
	if err != nil {
		t.Fatal(err)
	}
	now = credentials.ExpiresAt
	w = authRequest(t, api, "GET", "/v1/library", credentials.SessionToken, "")
	if w.Code != 401 || errorCode(t, w) != "SESSION_EXPIRED" {
		t.Fatal("expired session retained API access")
	}
}

func TestAuthLoginStrictBoundedSchemaSafeFailureAndRate(t *testing.T) {
	api := New(&authBoundaryBackend{}, Options{Auth: authFixture(t, nil)})
	for _, body := range []string{`{}`, `{"Username":"admin","password":"test"}`, `{"username":"admin","password":"test","Password":"test"}`, `{"username":"admin","password":"test","password":"test"}`, `{"username":"admin","password":null}`, `{"username":"admin","password":42}`, `{"username":"admin","password":"test","registration":true}`, `{"username":"admin","password":"` + strings.Repeat("x", 4096) + `"}`} {
		w := authRequest(t, api, "POST", "/v1/auth/login", "", body)
		if w.Code != 400 && w.Code != 413 {
			t.Fatal("malformed sign-in accepted")
		}
		if bytes.Contains(w.Body.Bytes(), []byte("test")) {
			t.Fatal("sign-in error reflected credential input")
		}
	}
	for i := 0; i < 5; i++ {
		w := authRequest(t, api, "POST", "/v1/auth/login", "", `{"username":"other-account","password":"Isolated API fixture 2026!"}`)
		if w.Code != 401 || errorCode(t, w) != "INVALID_CREDENTIALS" {
			t.Fatal("invalid login failed unsafely")
		}
	}
	w := authRequest(t, api, "POST", "/v1/auth/login", "", `{"username":"admin","password":"Isolated API fixture 2026!"}`)
	if w.Code != 429 || errorCode(t, w) != "AUTH_RATE_LIMITED" || w.Header().Get("Retry-After") != "60" {
		t.Fatal("HTTP login rate limit missing")
	}
	uninitialized := New(&authBoundaryBackend{}, Options{})
	if errorCode(t, authRequest(t, uninitialized, "POST", "/v1/auth/login", "", `{"username":"admin","password":"test"}`)) != "AUTH_NOT_INITIALIZED" {
		t.Fatal("uninitialized login is not explicit")
	}
}

func TestAuthorizationHeaderAndLogoutBodyFailClosed(t *testing.T) {
	manager := authFixture(t, nil)
	session, err := manager.Login("admin", []byte("Isolated API fixture 2026!"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(&authBoundaryBackend{}, Options{Auth: manager})
	for _, values := range [][]string{{"Basic ignored"}, {"bearer " + session.SessionToken}, {"Bearer " + session.SessionToken + " "}, {"Bearer " + session.SessionToken, "Bearer " + session.SessionToken}} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:4137/v1/library", nil)
		r.RemoteAddr = "127.0.0.1:50000"
		for _, value := range values {
			r.Header.Add("Authorization", value)
		}
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("ambiguous or incorrect authorization accepted")
		}
	}
	w := authRequest(t, api, "DELETE", "/v1/auth/session", session.SessionToken, `{}`)
	if w.Code != 400 || errorCode(t, w) != "INVALID_INPUT" {
		t.Fatal("logout body accepted")
	}
	if _, err := manager.Validate(session.SessionToken); err != nil {
		t.Fatal("invalid logout revoked session")
	}
}
