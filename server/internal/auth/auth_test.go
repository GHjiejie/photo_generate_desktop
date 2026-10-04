package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const fixturePassword = "Isolated admin fixture 2026!"

func credentialPath(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, "admin-auth.json")
}
func managerFixture(t *testing.T, options Options) (*Manager, string) {
	t.Helper()
	path := credentialPath(t)
	if err := Initialize(path, []byte(fixturePassword)); err != nil {
		t.Fatal(err)
	}
	manager, err := Open(path, options)
	if err != nil {
		t.Fatal(err)
	}
	return manager, path
}
func code(t *testing.T, err error) string {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) {
		t.Fatal("expected public authentication error")
	}
	return typed.Code
}

func TestUninitializedAndNoDefaultPassword(t *testing.T) {
	missing := credentialPath(t)
	manager, err := Open(missing, Options{})
	if err != nil || manager.Initialized() {
		t.Fatal("missing hash should remain uninitialized")
	}
	for _, value := range []*Manager{manager, nil} {
		if _, err := value.Login(Username, []byte(fixturePassword)); code(t, err) != "AUTH_NOT_INITIALIZED" {
			t.Fatal("uninitialized login accepted")
		}
		if _, err := value.Validate(strings.Repeat("a", 43)); code(t, err) != "AUTH_NOT_INITIALIZED" {
			t.Fatal("uninitialized session accepted")
		}
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("opening uninitialized auth created a credential")
	}
}

func TestPasswordHashRandomnessStrictFileAndExclusiveInitialization(t *testing.T) {
	one, two := credentialPath(t), credentialPath(t)
	for _, path := range []string{one, two} {
		if err := Initialize(path, []byte(fixturePassword)); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := os.ReadFile(one)
	b, _ := os.ReadFile(two)
	if bytes.Equal(a, b) || bytes.Contains(a, []byte(fixturePassword)) {
		t.Fatal("password hash was deterministic or plaintext")
	}
	info, _ := os.Stat(one)
	if info.Mode().Perm() != 0600 {
		t.Fatal("hash file is not private")
	}
	if Initialize(one, []byte("A different fixture password!")) == nil {
		t.Fatal("existing hash overwritten")
	}
	after, _ := os.ReadFile(one)
	if !bytes.Equal(a, after) {
		t.Fatal("failed initialization changed existing hash")
	}
	if Initialize(credentialPath(t), []byte("short")) == nil {
		t.Fatal("weak initialization password accepted")
	}
	if !ValidPassword([]byte("十二个字符的中文安全密码短语")) || ValidPassword([]byte("Long fixture password\n")) || ValidPassword(bytes.Repeat([]byte("x"), 1025)) {
		t.Fatal("initialization Unicode/length/control rules changed")
	}
}

func TestCredentialSchemaAndFilesystemFailClosed(t *testing.T) {
	_, source := managerFixture(t, Options{})
	data, _ := os.ReadFile(source)
	var record map[string]any
	if json.Unmarshal(data, &record) != nil {
		t.Fatal("fixture format")
	}
	for _, test := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown-version", func(v map[string]any) { v["version"] = 2 }},
		{"other-user", func(v map[string]any) { v["username"] = "operator" }},
		{"unsafe-cost", func(v map[string]any) { v["memoryKiB"] = 2147483647 }},
		{"missing-field", func(v map[string]any) { delete(v, "salt") }},
		{"unknown-field", func(v map[string]any) { v["password"] = "not-a-production-password" }},
		{"case-alias", func(v map[string]any) { v["Version"] = 1 }},
		{"base64-newline", func(v map[string]any) { v["salt"] = v["salt"].(string) + "\n" }},
		{"padded-hash", func(v map[string]any) { v["hash"] = v["hash"].(string) + "=" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			copy := map[string]any{}
			for k, v := range record {
				copy[k] = v
			}
			test.change(copy)
			encoded, _ := json.Marshal(copy)
			path := credentialPath(t)
			if os.WriteFile(path, encoded, 0600) != nil {
				t.Fatal("fixture write")
			}
			if _, err := Open(path, Options{}); err == nil {
				t.Fatal("unsafe hash accepted")
			}
		})
	}
	for _, bad := range [][]byte{bytes.Replace(data, []byte(`"version":1`), []byte(`"version":1,"version":1`), 1), append(append([]byte{}, data...), []byte(`{}`)...), bytes.Repeat([]byte("x"), maxCredentialBytes+1)} {
		path := credentialPath(t)
		_ = os.WriteFile(path, bad, 0600)
		if _, err := Open(path, Options{}); err == nil {
			t.Fatal("duplicate/trailing/oversize credential accepted")
		}
	}
	t.Run("public-mode", func(t *testing.T) {
		path := credentialPath(t)
		_ = os.WriteFile(path, data, 0644)
		if _, err := Open(path, Options{}); err == nil {
			t.Fatal("public credential accepted")
		}
	})
	t.Run("hardlink", func(t *testing.T) {
		path := credentialPath(t)
		_ = os.WriteFile(path, data, 0600)
		if err := os.Link(path, path+".link"); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(path, Options{}); err == nil {
			t.Fatal("linked credential accepted")
		}
	})
	t.Run("symlink", func(t *testing.T) {
		path := credentialPath(t)
		if err := os.Symlink(source, path); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(path, Options{}); err == nil {
			t.Fatal("symlink credential accepted")
		}
		if Initialize(path, []byte(fixturePassword)) == nil {
			t.Fatal("symlink replaced")
		}
		unchanged, _ := os.ReadFile(source)
		if !bytes.Equal(unchanged, data) {
			t.Fatal("symlink target changed")
		}
	})
	t.Run("public-parent", func(t *testing.T) {
		path := credentialPath(t)
		_ = os.Chmod(filepath.Dir(path), 0755)
		if _, err := Open(path, Options{}); err == nil {
			t.Fatal("public config directory accepted")
		}
	})
	t.Run("ancestor-symlink", func(t *testing.T) {
		path := credentialPath(t)
		alias := credentialPath(t) + ".dir"
		if err := os.Symlink(filepath.Dir(path), alias); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(filepath.Join(alias, "admin-auth.json"), Options{}); err == nil {
			t.Fatal("symlink ancestor accepted")
		}
	})
}

func TestPHCEnvironmentAndPrivateEnvInitialization(t *testing.T) {
	path := credentialPath(t)
	if err := InitializeEnv(path, []byte(fixturePassword)); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if bytes.Contains(data, []byte(fixturePassword)) {
		t.Fatal("environment initialization wrote plaintext")
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || lines[0] != "PORTRAIT_STUDIO_ADMIN_USERNAME=admin" || !strings.HasPrefix(lines[1], "PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH='") || !strings.HasSuffix(lines[1], "'") {
		t.Fatal("environment hash is not safely quoted")
	}
	phc := strings.TrimSuffix(strings.TrimPrefix(lines[1], "PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH='"), "'")
	manager, err := Open("", Options{PasswordHash: phc})
	if err != nil || !manager.Initialized() {
		t.Fatal("valid PHC not loaded")
	}
	if _, err = manager.Login(Username, []byte(fixturePassword)); err != nil {
		t.Fatal("PHC login failed")
	}
	if _, err = Open(path, Options{PasswordHash: phc}); err == nil {
		t.Fatal("ambiguous credential sources accepted")
	}
	for _, bad := range []string{phc + "\n", strings.Replace(phc, "m=19456", "m=999999999", 1), strings.Replace(phc, "v=19", "v=16", 1), strings.Replace(phc, "argon2id", "argon2i", 1), strings.Replace(phc, "t=2,p=1", "p=1,t=2", 1), phc + "=", phc + "$", strings.Replace(phc, "$", "$$", 1)} {
		if _, err := Open("", Options{PasswordHash: bad}); err == nil {
			t.Fatal("invalid PHC accepted")
		}
	}
	before := append([]byte{}, data...)
	if InitializeEnv(path, []byte(fixturePassword)) == nil {
		t.Fatal("env file replaced")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("existing environment changed")
	}
}

func TestSessionLifetimeLogoutRestartAndCanonicalToken(t *testing.T) {
	now := time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	manager, path := managerFixture(t, Options{Now: func() time.Time { return now }})
	login, err := manager.Login(Username, []byte(fixturePassword))
	if err != nil {
		t.Fatal(err)
	}
	if len(login.SessionToken) != 43 || login.Username != Username || !login.ExpiresAt.Equal(now.Add(8*time.Hour)) {
		t.Fatal("session contract changed")
	}
	if _, err = base64.RawURLEncoding.Strict().DecodeString(login.SessionToken); err != nil {
		t.Fatal("token is not canonical random bytes")
	}
	for _, bad := range []string{"", login.SessionToken + "=", login.SessionToken + "\n", strings.Repeat("x", 43)} {
		if _, err = manager.Validate(bad); code(t, err) != "AUTH_REQUIRED" {
			t.Fatal("invalid token accepted")
		}
	}
	now = login.ExpiresAt.Add(-time.Nanosecond)
	if _, err = manager.Validate(login.SessionToken); err != nil {
		t.Fatal("session expired early")
	}
	now = login.ExpiresAt
	if _, err = manager.Validate(login.SessionToken); code(t, err) != "SESSION_EXPIRED" {
		t.Fatal("8h boundary was not enforced")
	}
	fresh, err := manager.Login(Username, []byte(fixturePassword))
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.Logout(fresh.SessionToken); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Validate(fresh.SessionToken); code(t, err) != "AUTH_REQUIRED" {
		t.Fatal("logout did not revoke")
	}
	fresh, err = manager.Login(Username, []byte(fixturePassword))
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Validate(fresh.SessionToken); code(t, err) != "AUTH_REQUIRED" {
		t.Fatal("restart retained bearer session")
	}
	digest := sha256.Sum256([]byte(fresh.SessionToken))
	if stored, exists := manager.sessions[digest]; !exists || stored.Username != Username || !stored.ExpiresAt.Equal(fresh.ExpiresAt) {
		t.Fatal("session was not stored under its SHA-256 token digest")
	}
}

func TestFixedAdminFailuresRateLimitAndHashConcurrency(t *testing.T) {
	var offset atomic.Int64
	base := time.Now()
	manager, _ := managerFixture(t, Options{Now: func() time.Time { return base.Add(time.Duration(offset.Load())) }})
	for i := 0; i < maxLoginAttempts; i++ {
		if _, err := manager.Login("administrator", []byte(fixturePassword)); code(t, err) != "INVALID_CREDENTIALS" {
			t.Fatal("other account accepted")
		}
	}
	if _, err := manager.Login(Username, []byte(fixturePassword)); code(t, err) != "AUTH_RATE_LIMITED" {
		t.Fatal("attempt limit did not apply")
	}
	offset.Add(int64(time.Minute))
	if _, err := manager.Login(Username, []byte(fixturePassword)); err != nil {
		t.Fatal("rate limit did not recover")
	}
	offset.Add(int64(time.Minute))
	var successes, limits atomic.Int32
	start := make(chan struct{})
	var wait sync.WaitGroup
	for i := 0; i < 20; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := manager.Login(Username, []byte(fixturePassword))
			if err == nil {
				successes.Add(1)
			} else if typed, ok := err.(*Error); ok && typed.Code == "AUTH_RATE_LIMITED" {
				limits.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	if successes.Load() != 1 || limits.Load() != 19 {
		t.Fatalf("parallel sign-in work not bounded: successful=%d limited=%d", successes.Load(), limits.Load())
	}
}

func TestSessionStorageBoundRevokesOldest(t *testing.T) {
	now := time.Now()
	manager, _ := managerFixture(t, Options{Now: func() time.Time { return now }})
	var first, last LoginResult
	for i := 0; i < maxSessions+1; i++ {
		now = now.Add(time.Minute)
		session, err := manager.Login(Username, []byte(fixturePassword))
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = session
		}
		last = session
	}
	if len(manager.sessions) != maxSessions {
		t.Fatal("session storage unbounded")
	}
	if _, err := manager.Validate(first.SessionToken); code(t, err) != "AUTH_REQUIRED" {
		t.Fatal("oldest session not revoked")
	}
	if _, err := manager.Validate(last.SessionToken); err != nil {
		t.Fatal("latest session not valid")
	}
}
