package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestFixedAdminEnvironmentAndNoPlaintextPassword(t *testing.T) {
	previous, exists := os.LookupEnv("PORTRAIT_STUDIO_ADMIN_PASSWORD")
	_ = os.Unsetenv("PORTRAIT_STUDIO_ADMIN_PASSWORD")
	t.Cleanup(func() {
		if exists {
			_ = os.Setenv("PORTRAIT_STUDIO_ADMIN_PASSWORD", previous)
		} else {
			_ = os.Unsetenv("PORTRAIT_STUDIO_ADMIN_PASSWORD")
		}
	})
	for _, username := range []string{"", "admin"} {
		t.Setenv("PORTRAIT_STUDIO_ADMIN_USERNAME", username)
		if err := adminEnvironment(); err != nil {
			t.Fatal("fixed account rejected")
		}
	}
	t.Setenv("PORTRAIT_STUDIO_ADMIN_USERNAME", "operator")
	if adminEnvironment() == nil {
		t.Fatal("second account accepted")
	}
	t.Setenv("PORTRAIT_STUDIO_ADMIN_USERNAME", "admin")
	t.Setenv("PORTRAIT_STUDIO_ADMIN_PASSWORD", "fixture-secret-not-for-production")
	err := adminEnvironment()
	if err == nil || strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("plaintext password environment accepted or echoed")
	}
}

func TestCredentialConfigurationCannotBeStoredInLibrary(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "photo_repo")
	if err = os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{data, filepath.Join(data, "admin-auth.json"), filepath.Join(data, "nested", "private.env")} {
		if !credentialInsideLibrary(file, data) {
			t.Fatal("credential inside gallery accepted")
		}
	}
	for _, file := range []string{filepath.Join(root, "config", "admin-auth.json"), filepath.Join(root, "photo_repo-other", "admin-auth.json")} {
		if credentialInsideLibrary(file, data) {
			t.Fatal("sibling private credential incorrectly rejected")
		}
	}
	alias := filepath.Join(root, "library-alias")
	if err = os.Symlink(data, alias); err != nil {
		t.Fatal(err)
	}
	if !credentialInsideLibrary(filepath.Join(alias, "admin-auth.json"), data) {
		t.Fatal("symlink gallery credential accepted")
	}
}

func TestInitializerRefusesPasswordArgumentsAndAmbiguousDestinations(t *testing.T) {
	t.Setenv("PORTRAIT_STUDIO_AUTH_FILE", "")
	for _, args := range [][]string{{}, {"-auth-file", "/private/tmp/fixture.json", "-env-file", "/private/tmp/fixture.env"}, {"-auth-file", "/private/tmp/fixture.json", "do-not-echo-fixture-password"}} {
		if err := initAdmin(args); err == nil || strings.Contains(err.Error(), "do-not-echo-fixture-password") {
			t.Fatal("password argument accepted or reflected")
		}
	}
}

func TestInitializerRefusesPipedPasswordWithoutCreatingCredentials(t *testing.T) {
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(path, "admin-auth.json")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(exe, "-test.run=^TestInitializerPipeChild$")
	child.Env = []string{"PATH=" + os.Getenv("PATH"), "PORTRAIT_INITIALIZER_PIPE_TEST=1", "PORTRAIT_INITIALIZER_PIPE_PATH=" + path}
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // no controlling terminal
	child.Stdin = strings.NewReader("Isolated piped fixture password!\nIsolated piped fixture password!\n")
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatal("initializer pipe refusal subprocess failed")
	}
	if !strings.Contains(string(output), "interactive local terminal") || strings.Contains(string(output), "Isolated piped fixture") {
		t.Fatal("piped initialization did not fail safely")
	}
	if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("piped input created credentials")
	}
}

func TestInitializerPipeChild(t *testing.T) {
	if os.Getenv("PORTRAIT_INITIALIZER_PIPE_TEST") != "1" {
		return
	}
	err := initAdmin([]string{"-auth-file", os.Getenv("PORTRAIT_INITIALIZER_PIPE_PATH")})
	if err == nil {
		os.Exit(2)
	}
	fmt.Print(err.Error())
	os.Exit(0)
}
