package auth

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/crypto/argon2"
)

const maxCredentialBytes = 4096

type credential struct{ salt, hash []byte }
type credentialFile struct {
	Version     int    `json:"version"`
	Username    string `json:"username"`
	Algorithm   string `json:"algorithm"`
	MemoryKiB   uint32 `json:"memoryKiB"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
	Hash        string `json:"hash"`
}

var errCredential = errors.New("admin credential file is invalid or unsafe; check its private owner, permissions and format")

const phcPrefix = "$argon2id$v=19$m=19456,t=2,p=1$"

func parsePHC(value string) (*credential, error) {
	if !strings.HasPrefix(value, phcPrefix) || len(value) > 256 {
		return nil, errCredential
	}
	parts := strings.Split(strings.TrimPrefix(value, phcPrefix), "$")
	if len(parts) != 2 {
		return nil, errCredential
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[0])
	if err != nil || len(salt) != 16 || base64.RawStdEncoding.EncodeToString(salt) != parts[0] {
		return nil, errCredential
	}
	hash, err := base64.RawStdEncoding.Strict().DecodeString(parts[1])
	if err != nil || len(hash) != 32 || base64.RawStdEncoding.EncodeToString(hash) != parts[1] {
		return nil, errCredential
	}
	return &credential{salt: salt, hash: hash}, nil
}

// openParent pins the directory and rejects symlink ancestors, including a
// symlink basename. Use an absolute, canonical path, e.g. /private/tmp on macOS.
func openParent(path string) (*os.Root, string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\x00\r\n") || filepath.Base(path) == "." {
		return nil, "", errCredential
	}
	parent := filepath.Dir(path)
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(parent, current), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, "", errCredential
		}
	}
	info, err := os.Lstat(parent)
	if err != nil || info.Mode().Perm() != 0700 {
		return nil, "", errCredential
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return nil, "", errCredential
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return nil, "", errCredential
	}
	// The directory opened by os.Root must still match the checked directory.
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		root.Close()
		return nil, "", errCredential
	}
	return root, filepath.Base(path), nil
}

func safeInfo(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && info.Mode().Perm() == 0600 && info.Size() > 0 && info.Size() <= maxCredentialBytes && stat.Nlink == 1 && int(stat.Uid) == os.Geteuid()
}

func readCredential(path string) (*credential, error) {
	root, name, err := openParent(path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	before, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !safeInfo(before) {
		return nil, errCredential
	}
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, errCredential
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !safeInfo(opened) || !os.SameFile(before, opened) {
		return nil, errCredential
	}
	data, err := io.ReadAll(io.LimitReader(f, maxCredentialBytes+1))
	if err != nil || len(data) > maxCredentialBytes || int64(len(data)) != opened.Size() {
		return nil, errCredential
	}
	after, err := root.Lstat(name)
	if err != nil || !safeInfo(after) || !os.SameFile(opened, after) || after.Size() != opened.Size() || !after.ModTime().Equal(opened.ModTime()) {
		return nil, errCredential
	}
	// Flat JSON schema; duplicates, unknown keys, trailing values and excessive
	// hashing parameters are rejected rather than accepted or migrated.
	probe := json.NewDecoder(bytes.NewReader(data))
	start, err := probe.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errCredential
	}
	keys := map[string]bool{}
	allowed := map[string]bool{"version": true, "username": true, "algorithm": true, "memoryKiB": true, "iterations": true, "parallelism": true, "salt": true, "hash": true}
	for probe.More() {
		key, err := probe.Token()
		if err != nil {
			return nil, errCredential
		}
		name, ok := key.(string)
		if !ok || !allowed[name] || keys[name] {
			return nil, errCredential
		}
		keys[name] = true
		var value any
		if probe.Decode(&value) != nil {
			return nil, errCredential
		}
	}
	if _, err = probe.Token(); err != nil {
		return nil, errCredential
	}
	if len(keys) != len(allowed) {
		return nil, errCredential
	}
	if _, err = probe.Token(); err != io.EOF {
		return nil, errCredential
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var record credentialFile
	if decoder.Decode(&record) != nil || record.Version != 1 || record.Username != Username || record.Algorithm != "argon2id" || record.MemoryKiB != passwordMemory || record.Iterations != passwordTime || record.Parallelism != passwordThreads {
		return nil, errCredential
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(record.Salt)
	if err != nil || len(salt) != 16 || base64.RawStdEncoding.EncodeToString(salt) != record.Salt {
		return nil, errCredential
	}
	hash, err := base64.RawStdEncoding.Strict().DecodeString(record.Hash)
	if err != nil || len(hash) != 32 || base64.RawStdEncoding.EncodeToString(hash) != record.Hash {
		return nil, errCredential
	}
	return &credential{salt: salt, hash: hash}, nil
}

// Initialize is called by the private TTY initializer (or isolated tests). It
// exclusively creates one hash file; existing files are never overwritten.
// The caller must already have created a private 0700 credential directory.
func Initialize(path string, password []byte) error {
	return initialize(path, password, false)
}

// InitializeEnv creates a private environment configuration containing only
// the fixed account name and a PHC Argon2id hash. No secret is printed.
func InitializeEnv(path string, password []byte) error {
	return initialize(path, password, true)
}
func initialize(path string, password []byte, environment bool) error {
	if !ValidPassword(password) {
		return errors.New("use a password of at least 12 characters and at most 1024 UTF-8 bytes, without control characters")
	}
	root, name, err := openParent(path)
	if err != nil {
		return err
	}
	defer root.Close()
	if _, err = root.Lstat(name); !errors.Is(err, os.ErrNotExist) {
		return errors.New("admin credential file already exists or is unsafe; it was not replaced")
	}
	salt := make([]byte, 16)
	if _, err = rand.Read(salt); err != nil {
		return errors.New("could not initialize admin authentication")
	}
	hash := argon2.IDKey(password, salt, passwordTime, passwordMemory, passwordThreads, 32)
	defer Erase(hash)
	var data []byte
	if environment {
		phc := phcPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(hash)
		data = []byte("PORTRAIT_STUDIO_ADMIN_USERNAME=admin\nPORTRAIT_STUDIO_ADMIN_PASSWORD_HASH='" + phc + "'\n")
	} else {
		data, err = json.Marshal(credentialFile{Version: 1, Username: Username, Algorithm: "argon2id", MemoryKiB: passwordMemory, Iterations: passwordTime, Parallelism: passwordThreads, Salt: base64.RawStdEncoding.EncodeToString(salt), Hash: base64.RawStdEncoding.EncodeToString(hash)})
		if err != nil {
			return errCredential
		}
		data = append(data, '\n')
	}
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return errors.New("admin credential file already exists or is unsafe; it was not replaced")
	}
	// O_EXCL never truncates an existing file; the file is private from its first
	// byte. A interrupted initialization leaves a fail-closed file to inspect.
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("admin initialization did not complete; inspect the private credential file before restarting")
	}
	directory, err := root.Open(".")
	if err != nil {
		return errCredential
	}
	defer directory.Close()
	if directory.Sync() != nil {
		return errors.New("admin credential durability could not be confirmed")
	}
	if !environment {
		if _, err = readCredential(path); err != nil {
			return fmt.Errorf("admin credential verification failed: %w", errCredential)
		}
	}
	return nil
}
