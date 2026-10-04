package httpapi

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"portraitstudio/server/internal/auth"
	"portraitstudio/server/internal/store"
)

// TestNativePlatformAuthHarness is deliberately test-only. Its isolated fixture
// credentials and stdin clock controls cannot be built into portrait-server.
func TestNativePlatformAuthHarness(t *testing.T) {
	if os.Getenv("PORTRAIT_STUDIO_NATIVE_AUTH_TEST") != "1" {
		t.Skip("explicit native test harness only")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "config")
	if err = os.Mkdir(config, 0700); err != nil {
		t.Fatal(err)
	}
	authFile := filepath.Join(config, "admin-auth.json")
	password := []byte("Native admin fixture 2026!")
	if err = auth.Initialize(authFile, password); err != nil {
		t.Fatal(err)
	}
	auth.Erase(password)
	var offset atomic.Int64
	clock := func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	manager, err := auth.Open(authFile, auth.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	uninitialized, err := auth.Open("", auth.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(root, "photo_repo"), 0700); err != nil {
		t.Fatal(err)
	}
	library, err := store.Open(filepath.Join(root, "photo_repo"))
	if err != nil {
		t.Fatal(err)
	}
	defer library.Close()
	created, err := library.Create(store.CreateInput{Metadata: store.Metadata{ID: 1, Label: "Native authentication fixture", Type: "photo", Prompts: store.Prompts{EN: "Complete isolated English test prompt", ZH: "完整的隔离认证测试提示词"}}, ExpectedVersion: 1, Image: testPNG(t, 40)})
	if err != nil {
		t.Fatal(err)
	}
	api := New(library, Options{Version: "native-auth-test", LibraryLabel: "Isolated native auth library", TempDir: root, Auth: manager})
	var guard sync.RWMutex
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal("isolated native auth listener unavailable:", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guard.RLock()
		defer guard.RUnlock()
		api.ServeHTTP(w, r)
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	emit := func(value map[string]any) {
		data, _ := json.Marshal(value)
		fmt.Printf("PORTRAIT_AUTH_HARNESS %s\n", data)
	}
	emit(map[string]any{"event": "ready", "endpoint": "http://" + listener.Addr().String() + "/", "mode": "isolated-test-only", "items": 1, "label": "Isolated native auth library", "dataRoot": filepath.Join(root, "photo_repo"), "credentialFilePath": authFile, "initialCount": 1, "initialRevision": created.Revision, "imageSHA": created.Item.SHA256})
	reader := bufio.NewScanner(os.Stdin)
	reader.Buffer(make([]byte, 128), 1024)
	for reader.Scan() {
		command := reader.Text()
		guard.Lock()
		switch command {
		case "expire":
			offset.Add(int64(auth.SessionLifetime + time.Second))
		case "restart":
			manager, err = auth.Open(authFile, auth.Options{Now: clock})
			if err == nil {
				api.options.Auth = manager
			}
		case "uninitialized":
			api.options.Auth = uninitialized
		case "initialized":
			api.options.Auth = manager
		case "stop":
			guard.Unlock()
			emit(map[string]any{"event": "stopped"})
			return
		default:
			guard.Unlock()
			t.Fatal("invalid harness control")
		}
		guard.Unlock()
		if err != nil {
			t.Fatal("test harness authentication restart failed")
		}
		emit(map[string]any{"event": "control", "command": command})
	}
	if reader.Err() != nil {
		t.Fatal("test harness control stream failed")
	}
}
