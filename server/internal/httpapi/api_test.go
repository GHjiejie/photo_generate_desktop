package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"portraitstudio/server/internal/auth"
	"portraitstudio/server/internal/store"
)

var testSessions sync.Map // only generated sessions for isolated test APIs

func request(t *testing.T, api http.Handler, method, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:4137"+path, bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	if native, ok := api.(*API); ok {
		if token, exists := testSessions.Load(native); exists {
			r.Header.Set("Authorization", "Bearer "+token.(string))
		}
	}
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	return w
}
func payload(t *testing.T, w *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	var result map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("response is not one JSON value: %q: %v", w.Body.String(), err)
	}
	return result
}
func success(t *testing.T, w *httptest.ResponseRecorder) json.RawMessage {
	t.Helper()
	p := payload(t, w)
	if w.Code != http.StatusOK || string(p["ok"]) != "true" {
		t.Fatalf("API failed %d: %s", w.Code, w.Body.String())
	}
	return p["data"]
}
func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	p := payload(t, w)
	if string(p["ok"]) != "false" {
		t.Fatalf("expected rejection: %s", w.Body.String())
	}
	var err store.Error
	if json.Unmarshal(p["error"], &err) != nil {
		t.Fatal("missing error")
	}
	return err.Code
}

type field struct{ name, value string }

type cancelAtEndReader struct {
	*bytes.Reader
	cancel context.CancelFunc
}

func (r *cancelAtEndReader) Read(buffer []byte) (int, error) {
	n, err := r.Reader.Read(buffer)
	if r.Len() == 0 {
		r.cancel()
	}
	return n, err
}

func multipartBody(t *testing.T, parts ...field) ([]byte, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, part := range parts {
		var out io.Writer
		var err error
		if part.name == "metadata" {
			out, err = writer.CreateFormField(part.name)
		} else {
			out, err = writer.CreateFormFile(part.name, "../../ignored-filename.png")
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.WriteString(out, part.value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), writer.FormDataContentType()
}
func testPNG(t *testing.T, red byte) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, 3, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 3; x++ {
			picture.SetNRGBA(x, y, color.NRGBA{R: red, G: byte(x), B: byte(y), A: 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, picture); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func openAPI(t *testing.T) (*store.Store, *API, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	library, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = library.Close() })
	authDirectory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(authDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	authPath := filepath.Join(authDirectory, "admin-auth.json")
	if err = auth.Initialize(authPath, []byte("Isolated API fixture 2026!")); err != nil {
		t.Fatal(err)
	}
	manager, err := auth.Open(authPath, auth.Options{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Login(auth.Username, []byte("Isolated API fixture 2026!"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(library, Options{Version: "test", TempDir: t.TempDir(), Auth: manager})
	testSessions.Store(api, session.SessionToken)
	t.Cleanup(func() { testSessions.Delete(api) })
	return library, api, root
}
func create(t *testing.T, api *API, id int, version int64, picture []byte) *httptest.ResponseRecorder {
	t.Helper()
	metadata, _ := json.Marshal(map[string]any{"id": id, "label": "Original", "type": "photo", "prompts": map[string]string{"en": "Complete English prompt\nSecond line", "zh": "完整中文提示词\n第二行"}, "expectedVersion": version})
	body, kind := multipartBody(t, field{"metadata", string(metadata)}, field{"image", string(picture)})
	return request(t, api, http.MethodPost, "/v1/portraits", kind, body)
}

func TestListenerAndRequestBoundaries(t *testing.T) {
	for _, value := range []string{"127.0.0.1:4137", "[::1]:4137"} {
		if err := LoopbackAddress(value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"0.0.0.0:4137", ":4137", "192.0.2.1:4137", "localhost:4137", "[::]:4137", "127.0.0.1:0"} {
		if LoopbackAddress(value) == nil {
			t.Fatalf("unsafe listener accepted %q", value)
		}
	}
	_, api, _ := openAPI(t)
	for _, test := range []struct{ name, host, origin, remote string }{{"foreign-host", "evil.test:4137", "", "127.0.0.1:9999"}, {"foreign-origin", "127.0.0.1:4137", "http://evil.test", "127.0.0.1:9999"}, {"foreign-client", "127.0.0.1:4137", "", "192.0.2.1:1234"}, {"bad-port", "127.0.0.1:0", "", "127.0.0.1:9999"}} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://127.0.0.1/healthz", nil)
			r.Host = test.host
			r.RemoteAddr = test.remote
			r.Header.Set("Origin", test.origin)
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != 403 || errorCode(t, w) != "FORBIDDEN" {
				t.Fatal(w.Body.String())
			}
		})
	}
	if code := errorCode(t, request(t, api, "GET", "/v1/library?path=/etc/passwd", "", nil)); code != "INVALID_INPUT" {
		t.Fatal(code)
	}
	for _, path := range []string{"/v1/portraits/1/../../etc/passwd", "/v1/portraits/%31", "/v1//library"} {
		w := request(t, api, "GET", path, "", nil)
		if w.Code == 200 {
			t.Fatalf("bad route accepted %s", path)
		}
	}
	for _, path := range []string{"/v1/portraits/1", "/v1/batches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/v1/batches/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/commit"} {
		w := request(t, api, "PUT", path, "", nil)
		if w.Code != 405 || errorCode(t, w) != "METHOD_NOT_ALLOWED" || w.Header().Get("Allow") == "" {
			t.Fatalf("method response %s", w.Body.String())
		}
	}
	data := success(t, request(t, api, "GET", "/healthz", "", nil))
	if bytes.Contains(data, []byte("items")) {
		t.Fatal("health leaks library data")
	}
}

func TestCRUDCASImagePinAndRecovery(t *testing.T) {
	library, api, root := openAPI(t)
	original := testPNG(t, 30)
	success(t, create(t, api, 1, 1, original))
	var initial struct {
		Revision int64        `json:"revision"`
		Items    []publicItem `json:"items"`
		Root     string       `json:"root"`
	}
	if err := json.Unmarshal(success(t, request(t, api, "GET", "/v1/library", "", nil)), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Revision != 2 || len(initial.Items) != 1 || initial.Root == root || initial.Items[0].ImageURL != "/v1/images/1?revision=1" {
		t.Fatalf("wrong snapshot %+v", initial)
	}
	w := request(t, api, "GET", "/v1/images/1?revision=1", "", nil)
	if w.Code != 200 || !bytes.Equal(original, w.Body.Bytes()) || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("image response changed bytes or lacked security headers")
	}
	for _, query := range []string{"revision=1&revision=1", "revision=1&path=/etc/passwd", "revision=1%3Bpath=x", "revision=01"} {
		if errorCode(t, request(t, api, "GET", "/v1/images/1?"+query, "", nil)) != "INVALID_INPUT" {
			t.Fatal(query)
		}
	}
	if errorCode(t, request(t, api, "GET", "/v1/images/1?revision=2", "", nil)) != "CONFLICT" {
		t.Fatal("stale image should fail")
	}
	update := `{"id":1,"label":"Edited","type":"art","prompts":{"en":"Entire English text\nend","zh":"完整中文\n结束"},"expectedVersion":1,"expectedRevision":1}`
	if errorCode(t, request(t, api, "PATCH", "/v1/portraits/1", "application/json", []byte(update))) != "CONFLICT" {
		t.Fatal("stale update committed")
	}
	update = strings.Replace(update, `"expectedVersion":1`, `"expectedVersion":2`, 1)
	success(t, request(t, api, "PATCH", "/v1/portraits/1", "application/json", []byte(update)))
	item, revision, err := library.Get(1)
	if err != nil || revision != 3 || item.Revision != 2 || item.Prompts.EN != "Entire English text\nend" || item.Prompts.ZH != "完整中文\n结束" {
		t.Fatalf("full prompts or CAS lost %+v %v", item, err)
	}
	if errorCode(t, request(t, api, "GET", "/v1/images/1?revision=1", "", nil)) != "CONFLICT" {
		t.Fatal("old revision served")
	}
	w = request(t, api, "GET", "/v1/images/1?revision=2", "", nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), original) {
		t.Fatal("metadata update changed image")
	}
	remove := `{"id":1,"expectedVersion":3,"expectedRevision":2,"confirmed":false}`
	if errorCode(t, request(t, api, "DELETE", "/v1/portraits/1", "application/json", []byte(remove))) != "CONFIRMATION_REQUIRED" {
		t.Fatal("unconfirmed delete accepted")
	}
	remove = strings.Replace(remove, "false", "true", 1)
	success(t, request(t, api, "DELETE", "/v1/portraits/1", "application/json", []byte(remove)))
	if _, _, err = library.Get(1); store.ErrorCode(err) != "NOT_FOUND" {
		t.Fatal("delete did not remove item")
	}
	if err = library.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	snapshot, err := reopened.List()
	if err != nil || len(snapshot.Items) != 0 || snapshot.Revision != 4 {
		t.Fatalf("restart mismatch %+v %v", snapshot, err)
	}
	var retained bool
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			data, e := os.ReadFile(path)
			if e == nil && bytes.Equal(data, original) {
				retained = true
			}
		}
		return nil
	})
	if !retained {
		t.Fatal("deleted original has no recoverable image copy")
	}
}

func TestStrictBodiesAndAbortedUploadsDoNotCommit(t *testing.T) {
	library, api, _ := openAPI(t)
	for _, value := range []string{`{"id":1,"id":2}`, `{"id":1,"unknown":true}`, `{"id":1} {}`, `null`, `{"id":1,"label":"\ud800"}`, `{"id":1,"prompts":{"en":"x","zh":"y","other":"z"}}`, "{\"id\":1,\"label\":\"\xff\"}"} {
		w := request(t, api, "PATCH", "/v1/portraits/1", "application/json", []byte(value))
		if errorCode(t, w) != "INVALID_INPUT" {
			t.Fatalf("body accepted %q: %s", value, w.Body.String())
		}
	}
	metadata := `{"id":1,"label":"One","type":"photo","prompts":{"en":"English","zh":"中文"},"expectedVersion":1}`
	if code := errorCode(t, request(t, api, "PATCH", "/v1/portraits/1", "application/json", bytes.Repeat([]byte(" "), (1<<20)+1))); code != "TOO_LARGE" {
		t.Fatalf("oversized JSON was not rejected: %s", code)
	}
	for _, parts := range [][]field{{{"metadata", metadata}, {"metadata", metadata}, {"image", string(testPNG(t, 2))}}, {{"metadata", metadata}, {"path", "/etc/passwd"}, {"image", string(testPNG(t, 2))}}} {
		body, kind := multipartBody(t, parts...)
		if errorCode(t, request(t, api, "POST", "/v1/portraits", kind, body)) != "INVALID_INPUT" {
			t.Fatal("extra upload field accepted")
		}
	}
	body, kind := multipartBody(t, field{"metadata", metadata}, field{"image", string(testPNG(t, 2))})
	truncated := body[:len(body)-10]
	if errorCode(t, request(t, api, "POST", "/v1/portraits", kind, truncated)) != "INVALID_INPUT" {
		t.Fatal("incomplete multipart committed")
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:4137/v1/portraits", bytes.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	token, _ := testSessions.Load(api)
	r.Header.Set("Authorization", "Bearer "+token.(string))
	r.Header.Set("Content-Type", kind)
	ctx, cancel := context.WithCancel(r.Context())
	cancel()
	r = r.WithContext(ctx)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if errorCode(t, w) != "ABORTED" {
		t.Fatal("canceled request accepted")
	}
	// Cancel only when the complete final multipart boundary arrives, after request handling began.
	r = httptest.NewRequest("POST", "http://127.0.0.1:4137/v1/portraits", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Authorization", "Bearer "+token.(string))
	r.Header.Set("Content-Type", kind)
	ctx, cancel = context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = io.NopCloser(&cancelAtEndReader{Reader: bytes.NewReader(body), cancel: cancel})
	r.ContentLength = int64(len(body))
	w = httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if errorCode(t, w) != "ABORTED" {
		t.Fatal("late canceled upload committed")
	}
	snapshot, err := library.List()
	if err != nil || snapshot.Revision != 1 || len(snapshot.Items) != 0 {
		t.Fatal("rejected requests mutated index")
	}
}

func TestBatchNestedPairingTranslationCollisionCancelAndIdempotence(t *testing.T) {
	library, api, root := openAPI(t)
	oldImage := testPNG(t, 10)
	newImage := testPNG(t, 240)
	success(t, create(t, api, 1, 1, oldImage))
	manifest := `{"source_file":"original.json","count_generated":1,"images":[{"id":1,"image":"generated_portraits/001_new.png","label":"New source","category":"来源分类","prompt":"Full original English prompt\nall details","extra":{"keep":true}}]}`
	metadata := `{"manifestRelativePath":"generated_portraits_manifest.json","expectedVersion":2,"type":"photo","collisionPolicy":"allocate-new","derivedChinesePrompts":{"1":"完整衍生中文提示词\n全部细节"}}`
	preview := func() store.BatchPreview {
		body, kind := multipartBody(t, field{"metadata", metadata}, field{"manifest", manifest}, field{"image:generated_portraits/001_new.png", string(newImage)})
		var result store.BatchPreview
		data := success(t, request(t, api, "POST", "/v1/batches/preview", kind, body))
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := preview()
	if first.Counts.Matched != 1 || first.Counts.Importable != 1 || first.Items[0].TargetID != 2 {
		t.Fatalf("invalid preview %+v", first)
	}
	success(t, request(t, api, "DELETE", "/v1/batches/"+first.PreviewID, "", nil))
	snapshot, _ := library.List()
	if snapshot.Revision != 2 || len(snapshot.Items) != 1 {
		t.Fatal("cancel wrote to library")
	}
	second := preview()
	commit := `{"expectedVersion":2,"confirmed":true}`
	success(t, request(t, api, "POST", "/v1/batches/"+second.PreviewID+"/commit", "application/json", []byte(commit)))
	snapshot, err := library.List()
	if err != nil || snapshot.Revision != 3 || len(snapshot.Items) != 2 {
		t.Fatalf("batch mutation %+v %v", snapshot, err)
	}
	item, _, err := library.Get(2)
	if err != nil || item.Prompts.EN != "Full original English prompt\nall details" || item.Prompts.ZH != "完整衍生中文提示词\n全部细节" {
		t.Fatalf("prompt provenance lost %+v %v", item, err)
	}
	var source map[string]any
	_ = json.Unmarshal(item.SourceMetadata, &source)
	if source["id"] != float64(1) || source["prompt"] != "Full original English prompt\nall details" || source["extra"] == nil {
		t.Fatal("original fields changed")
	}
	var imported map[string]any
	_ = json.Unmarshal(item.SourceImport, &imported)
	if imported["sourceId"] != float64(1) || imported["sourceRelativePath"] != "generated_portraits/001_new.png" || imported["translationProvenance"] == nil {
		t.Fatalf("source identity/provenance missing %s", item.SourceImport)
	}
	archive, ok := imported["archiveRel"].(string)
	if !ok {
		t.Fatal("batch archive missing")
	}
	archived, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(archive), "manifest.json"))
	if err != nil || !bytes.Equal(archived, []byte(manifest)) {
		t.Fatalf("original manifest bytes changed: %v", err)
	}
	hash := sha256.Sum256(newImage)
	if item.SHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal("image hash changed")
	}
	imageResult, _ := library.ReadImage(1)
	if !bytes.Equal(imageResult.Bytes, oldImage) {
		t.Fatal("collision overwrote old image")
	}
	metadata = strings.Replace(metadata, `"expectedVersion":2`, `"expectedVersion":3`, 1)
	third := preview()
	if third.Counts.Importable != 0 || third.Counts.Skipped != 1 {
		t.Fatalf("identical batch did not skip %+v", third)
	}
	commit = `{"expectedVersion":3,"confirmed":true}`
	success(t, request(t, api, "POST", "/v1/batches/"+third.PreviewID+"/commit", "application/json", []byte(commit)))
	snapshot, _ = library.List()
	if snapshot.Revision != 3 || len(snapshot.Items) != 2 {
		t.Fatal("idempotent reimport changed index")
	}
}

func TestBatchUploadSafetyAndStageCleanup(t *testing.T) {
	library, api, _ := openAPI(t)
	manifest := `[{"id":1,"image":"001.png","label":"One","prompt_en":"English","prompt_zh":"中文"}]`
	metadata := `{"manifestRelativePath":"manifest.json","type":"photo","collisionPolicy":"allocate-new"}`
	for _, name := range []string{"image:../001.png", "image:/001.png", "image:child\\001.png", "image:a/b/c/d/001.png", "unexpected"} {
		body, kind := multipartBody(t, field{"metadata", metadata}, field{"manifest", manifest}, field{name, string(testPNG(t, 2))})
		w := request(t, api, "POST", "/v1/batches/preview", kind, body)
		if w.Code == 200 {
			t.Fatalf("unsafe part accepted %q", name)
		}
	}
	for _, value := range []string{`{"manifestRelativePath":"../manifest.json","type":"photo"}`, `{"manifestRelativePath":"manifest.json","type":"photo","imagePaths":{"001.png":"/etc/passwd"}}`, `{"manifestRelativePath":"manifest.json","type":"photo","derivedChinesePrompts":{"1":"first","1":"second"}}`} {
		body, kind := multipartBody(t, field{"metadata", value}, field{"manifest", manifest}, field{"image:001.png", string(testPNG(t, 2))})
		if request(t, api, "POST", "/v1/batches/preview", kind, body).Code == 200 {
			t.Fatal("unsafe metadata accepted")
		}
	}
	body, kind := multipartBody(t, field{"metadata", metadata}, field{"manifest", manifest}, field{"image:001.png", string(testPNG(t, 2))}, field{"image:001.png", string(testPNG(t, 3))})
	if errorCode(t, request(t, api, "POST", "/v1/batches/preview", kind, body)) != "INVALID_INPUT" {
		t.Fatal("duplicate uploaded source accepted")
	}
	entries, err := os.ReadDir(api.options.TempDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("HTTP owned staging leaked %v %v", entries, err)
	}
	snapshot, _ := library.List()
	if snapshot.Revision != 1 || len(snapshot.Items) != 0 {
		t.Fatal("rejected batch wrote index")
	}
}
