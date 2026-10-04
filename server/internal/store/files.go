package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
)

const meta = ".portrait-studio"
const indexRel = meta + "/library.json"

var tokenPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var imagePattern = regexp.MustCompile(`^assets/images/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?i:png|jpe?g|webp)$`)

// Store serializes operations and holds an advisory process lock for its lifetime.
// os.Root additionally confines all durable accesses to the opened root descriptor.
type Store struct {
	mu               sync.Mutex
	root             *os.Root
	rootPath         string
	rootInfo         os.FileInfo
	dirs             map[string]os.FileInfo
	lock             *os.File
	lockInfo         os.FileInfo
	indexHash        string
	previews         map[string]*batchPlan
	fault            func(string) error
	operationContext context.Context
	closed           bool
}

func token() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func encode(v any) ([]byte, error) {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return nil, e
	}
	return append(b, '\n'), nil
}
func safeRelative(name string) bool {
	if name == "" || len(name) > 4096 || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "\\:\x00") {
		return false
	}
	for _, r := range name {
		if r < 32 || r == 127 {
			return false
		}
	}
	for _, p := range strings.Split(name, "/") {
		if p == "" || p == "." || p == ".." || len(p) > 255 {
			return false
		}
	}
	return true
}
func noLinkAbsolute(name string) (os.FileInfo, error) {
	if !filepath.IsAbs(name) || filepath.Clean(name) != name {
		return nil, fail("UNSAFE_PATH", "Root must be a clean absolute directory")
	}
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(name, current), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, e := os.Lstat(current)
		if e != nil {
			return nil, e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fail("UNSAFE_PATH", "Symbolic links are not allowed")
		}
		if current != name && !info.IsDir() {
			return nil, fail("UNSAFE_PATH", "Invalid ancestor")
		}
	}
	return os.Lstat(name)
}
func Open(root string) (*Store, error) {
	info, e := noLinkAbsolute(root)
	if e != nil {
		return nil, e
	}
	if !info.IsDir() {
		return nil, fail("INVALID_ROOT", "Library root must be a directory")
	}
	r, e := os.OpenRoot(root)
	if e != nil {
		return nil, e
	}
	descriptor, e := r.OpenFile(".", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		r.Close()
		return nil, e
	}
	descriptorInfo, e := descriptor.Stat()
	descriptor.Close()
	if e != nil || !os.SameFile(info, descriptorInfo) {
		r.Close()
		return nil, fail("UNSAFE_PATH", "Root changed while opening")
	}
	s := &Store{root: r, rootPath: root, rootInfo: info, dirs: map[string]os.FileInfo{}, previews: map[string]*batchPlan{}}
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	for _, d := range []string{"assets", "assets/images", meta, meta + "/go-transactions", meta + "/recovery", meta + "/imports", meta + "/go-staging"} {
		if e = s.mkdir(d); e != nil {
			return nil, e
		}
	}
	if _, e = s.check(meta+"/go-store.lock", true); e != nil {
		return nil, e
	}
	s.lock, e = r.OpenFile(meta+"/go-store.lock", os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	s.lockInfo, e = s.lock.Stat()
	if e != nil {
		return nil, e
	}
	li, e := s.root.Lstat(meta + "/go-store.lock")
	if e != nil || !li.Mode().IsRegular() || !os.SameFile(li, s.lockInfo) {
		return nil, fail("UNSAFE_PATH", "Lock was replaced while opening")
	}
	if e = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, fail("LIBRARY_BUSY", "Library is already open in another server process")
	}
	if _, e = s.read(indexRel, MaxIndex); errors.Is(e, os.ErrNotExist) {
		initial := Snapshot{SchemaVersion: 1, Revision: 1, UpdatedAt: utcNow(), Items: []Item{}}
		b, _ := encode(initial)
		if e = s.atomic(indexRel, b, ""); e != nil {
			return nil, e
		}
	} else if e != nil {
		return nil, e
	}
	if e = s.recoverTransactions(); e != nil {
		return nil, e
	}
	idx, _, e := s.load(true)
	if e != nil {
		return nil, e
	}
	for _, item := range idx.Items {
		b, e := s.read(item.ImageRel, MaxImage)
		if e != nil {
			return nil, e
		}
		if int64(len(b)) != item.Size || digest(b) != item.SHA256 {
			return nil, fail("CONFLICT", "Image differs from its index")
		}
		im, e := inspectImage(b)
		if e != nil || im.mime != item.MIME {
			return nil, fail("INVALID_IMAGE", "Indexed image cannot be decoded")
		}
	}
	// Pending previews deliberately do not survive restart. Preserve their bytes
	// as recoverable abandoned staging, never treat them as committed gallery data.
	names, e := s.directoryNames(meta + "/go-staging")
	if e != nil {
		return nil, e
	}
	for _, name := range names {
		if !tokenPattern.MatchString(name) {
			return nil, fail("RECOVERY_CONFLICT", "Unrecognized staging entry")
		}
		if e = s.movePreserved(meta+"/go-staging/"+name, meta+"/recovery/"+name+"-abandoned-preview"); e != nil {
			return nil, e
		}
	}
	ok = true
	return s, nil
}
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var first error
	if s.lock != nil {
		syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
		first = s.lock.Close()
	}
	if s.root != nil {
		if e := s.root.Close(); first == nil {
			first = e
		}
	}
	return first
}
func (s *Store) check(name string, optional bool) (os.FileInfo, error) {
	if s.closed {
		return nil, fail("IO_ERROR", "Store is closed")
	}
	if !safeRelative(name) {
		return nil, fail("UNSAFE_PATH", "Unsafe relative path")
	}
	ri, e := os.Lstat(s.rootPath)
	if e != nil {
		return nil, e
	}
	if ri.Mode()&os.ModeSymlink != 0 || !os.SameFile(ri, s.rootInfo) {
		return nil, fail("UNSAFE_PATH", "Library root was replaced")
	}
	if s.lockInfo != nil {
		li, le := s.root.Lstat(meta + "/go-store.lock")
		if le != nil || li.Mode()&os.ModeSymlink != 0 || !os.SameFile(li, s.lockInfo) {
			return nil, fail("LIBRARY_BUSY", "Library lock file was replaced")
		}
	}
	parts := strings.Split(name, "/")
	var info os.FileInfo
	for i := range parts {
		n := strings.Join(parts[:i+1], "/")
		info, e = s.root.Lstat(n)
		if errors.Is(e, os.ErrNotExist) && optional && i == len(parts)-1 {
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fail("UNSAFE_PATH", "Symbolic links are not allowed")
		}
		if i < len(parts)-1 && !info.IsDir() {
			return nil, fail("UNSAFE_PATH", "Invalid directory ancestor")
		}
		if info.IsDir() {
			if prior, ok := s.dirs[n]; ok && !os.SameFile(prior, info) {
				return nil, fail("UNSAFE_PATH", "Managed directory was replaced")
			}
			s.dirs[n] = info
		}
	}
	return info, nil
}
func (s *Store) mkdir(name string) error {
	parent := path.Dir(name)
	if parent != "." {
		if _, e := s.check(parent, false); e != nil {
			return e
		}
	}
	info, e := s.check(name, true)
	if e != nil {
		return e
	}
	if info == nil {
		if e = s.root.Mkdir(name, 0700); e != nil {
			return e
		}
		if e = s.syncDir(parent); e != nil {
			return e
		}
	}
	info, e = s.check(name, false)
	if e != nil {
		return e
	}
	if !info.IsDir() {
		return fail("UNSAFE_PATH", "Expected a directory")
	}
	return nil
}
func (s *Store) read(name string, limit int64) ([]byte, error) {
	pi, e := s.check(name, false)
	if e != nil {
		return nil, e
	}
	if !pi.Mode().IsRegular() || pi.Size() > limit || pi.Size() < 0 {
		return nil, fail("INVALID_DATA", "Expected a bounded regular file")
	}
	f, e := s.root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	before, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !os.SameFile(pi, before) {
		return nil, fail("CONFLICT", "File was replaced")
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	if e != nil {
		return nil, e
	}
	pi, e = s.check(name, false)
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > limit || int64(len(b)) != before.Size() || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || !os.SameFile(before, pi) {
		return nil, fail("CONFLICT", "File changed while reading")
	}
	return b, nil
}
func (s *Store) writeExclusive(name string, b []byte) error {
	if info, e := s.check(name, true); e != nil {
		return e
	} else if info != nil {
		return fail("CONFLICT", "Target file already exists")
	}
	f, e := s.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return s.syncDir(path.Dir(name))
}
func (s *Store) syncDir(name string) error {
	if name != "." {
		info, e := s.check(name, false)
		if e != nil {
			return e
		}
		if !info.IsDir() {
			return fail("UNSAFE_PATH", "Expected directory")
		}
	}
	f, e := s.root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func (s *Store) atomic(name string, b []byte, expected string) error {
	old, e := s.read(name, MaxIndex)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if e == nil && expected == "" || e == nil && digest(old) != expected || errors.Is(e, os.ErrNotExist) && expected != "" {
		return fail("CONFLICT", "Index changed before commit")
	}
	tmp := path.Join(path.Dir(name), "."+path.Base(name)+"-"+token()+".tmp")
	if e = s.writeExclusive(tmp, b); e != nil {
		return e
	}
	// Compare immediately before the atomic replace, in addition to the process lock.
	current, ce := s.read(name, MaxIndex)
	if ce == nil && digest(current) != expected || errors.Is(ce, os.ErrNotExist) && expected != "" || ce != nil && !errors.Is(ce, os.ErrNotExist) {
		return fail("CONFLICT", "Index changed before atomic replace")
	}
	if e = s.root.Rename(tmp, name); e != nil {
		return e
	}
	return s.syncDir(path.Dir(name))
}
func (s *Store) directoryNames(name string) ([]string, error) {
	if _, e := s.check(name, false); e != nil {
		return nil, e
	}
	f, e := s.root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	return f.Readdirnames(-1)
}
func (s *Store) movePreserved(from, to string) error {
	if _, e := s.check(from, false); e != nil {
		return e
	}
	if info, e := s.check(to, true); e != nil {
		return e
	} else if info != nil {
		return fail("RECOVERY_CONFLICT", "Recovery destination exists")
	}
	if e := s.root.Rename(from, to); e != nil {
		return e
	}
	delete(s.dirs, from)
	if e := s.syncDir(path.Dir(from)); e != nil {
		return e
	}
	return s.syncDir(path.Dir(to))
}
func (s *Store) removeOwnedTree(name string) error {
	info, e := s.check(name, false)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	if !info.IsDir() {
		return fail("UNSAFE_PATH", "Expected owned transaction directory")
	}
	names, e := s.directoryNames(name)
	if e != nil {
		return e
	}
	for _, n := range names {
		rel := name + "/" + n
		st, e := s.check(rel, false)
		if e != nil {
			return e
		}
		if st.IsDir() {
			e = s.removeOwnedTree(rel)
		} else if st.Mode().IsRegular() {
			e = s.root.Remove(rel)
		} else {
			e = fail("UNSAFE_PATH", "Unexpected transaction entry")
		}
		if e != nil {
			return e
		}
	}
	if e = s.root.Remove(name); e != nil {
		return e
	}
	delete(s.dirs, name)
	return s.syncDir(path.Dir(name))
}
func cloneSnapshot(in Snapshot) Snapshot {
	b, _ := json.Marshal(in)
	var out Snapshot
	json.Unmarshal(b, &out)
	return out
}
func equalJSON(a, b []byte) bool {
	var x, y any
	d := json.NewDecoder(bytes.NewReader(a))
	d.UseNumber()
	if d.Decode(&x) != nil {
		return false
	}
	d = json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if d.Decode(&y) != nil {
		return false
	}
	xx, _ := json.Marshal(x)
	yy, _ := json.Marshal(y)
	return bytes.Equal(xx, yy)
}
