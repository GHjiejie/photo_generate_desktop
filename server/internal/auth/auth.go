// Package auth provides the platform's single, fixed admin account. Passwords
// are never stored, and bearer sessions exist only in this process's memory.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	Username         = "admin"
	SessionLifetime  = 8 * time.Hour
	MaxPasswordBytes = 1024
	passwordMemory   = 19 * 1024 // KiB; OWASP Argon2id minimum, bounded concurrency.
	passwordTime     = 2
	passwordThreads  = 1
	maxSessions      = 8
	maxLoginAttempts = 5
	loginWindow      = time.Minute
)

// Error contains a public code and a fixed safe message, never a secret or a
// filesystem/cryptographic error. It is safe to serialize at the API boundary.
type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Message }
func failure(code string) *Error {
	message := map[string]string{
		"AUTH_NOT_INITIALIZED": "The admin password has not been initialized by the server owner.",
		"AUTH_REQUIRED":        "Sign in to access the portrait library.",
		"SESSION_EXPIRED":      "The session has expired. Sign in again.",
		"INVALID_CREDENTIALS":  "The admin name or password is incorrect.",
		"AUTH_RATE_LIMITED":    "Too many sign-in attempts. Wait a minute before trying again.",
		"AUTH_UNAVAILABLE":     "Authentication is temporarily unavailable.",
	}[code]
	return &Error{Code: code, Message: message}
}

type Session struct {
	Username  string    `json:"username"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type LoginResult struct {
	SessionToken string    `json:"sessionToken"`
	Username     string    `json:"username"`
	ExpiresAt    time.Time `json:"expiresAt"`
}
type storedSession struct {
	Session
	issuedAt time.Time
}

// Options permits deterministic clocks in isolated tests. Session lifetimes,
// hashing costs and account names cannot be weakened through configuration.
type Options struct {
	Now func() time.Time
	// PasswordHash is a secret supplied by a private environment configuration,
	// never a plaintext password. It cannot be combined with a credential file.
	PasswordHash string
}
type Manager struct {
	credential *credential
	now        func() time.Time
	mu         sync.Mutex
	sessions   map[[32]byte]storedSession
	attempts   []time.Time
	hashing    chan struct{}
}

// Open accepts a missing credential file as uninitialized, never as anonymous
// access. Existing malformed, public, linked or unknown-format files fail closed.
func Open(path string, options Options) (*Manager, error) {
	var record *credential
	var err error
	if path != "" && options.PasswordHash != "" {
		return nil, errors.New("configure exactly one admin hash source: credential file or password hash environment")
	}
	if options.PasswordHash != "" {
		record, err = parsePHC(options.PasswordHash)
	} else if path != "" {
		record, err = readCredential(path)
	}
	if err != nil {
		return nil, err
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Manager{credential: record, now: now, sessions: make(map[[32]byte]storedSession), hashing: make(chan struct{}, 1)}, nil
}
func (m *Manager) Initialized() bool { return m != nil && m.credential != nil }

// ValidPassword is for first initialization only. Login does not disclose
// whether an incorrect password meets the initialization rules.
func ValidPassword(password []byte) bool {
	if !utf8.Valid(password) || len(password) > MaxPasswordBytes || utf8.RuneCount(password) < 12 {
		return false
	}
	for _, r := range string(password) {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

// Erase drops mutable plaintext copies as soon as they are no longer needed.
func Erase(value []byte) {
	for i := range value {
		value[i] = 0
	}
}

func (m *Manager) Login(username string, password []byte) (LoginResult, error) {
	if !m.Initialized() {
		return LoginResult{}, failure("AUTH_NOT_INITIALIZED")
	}
	now := m.now().UTC()
	m.mu.Lock()
	cutoff := now.Add(-loginWindow)
	kept := m.attempts[:0]
	for _, attempt := range m.attempts {
		if attempt.After(cutoff) {
			kept = append(kept, attempt)
		}
	}
	m.attempts = kept
	if len(m.attempts) >= maxLoginAttempts {
		m.mu.Unlock()
		return LoginResult{}, failure("AUTH_RATE_LIMITED")
	}
	m.attempts = append(m.attempts, now)
	m.mu.Unlock()
	select {
	case m.hashing <- struct{}{}:
		defer func() { <-m.hashing }()
	default:
		return LoginResult{}, failure("AUTH_RATE_LIMITED")
	}
	if len(password) == 0 || len(password) > MaxPasswordBytes || !utf8.Valid(password) {
		return LoginResult{}, failure("INVALID_CREDENTIALS")
	}
	record := m.credential
	derived := argon2.IDKey(password, record.salt, passwordTime, passwordMemory, passwordThreads, 32)
	valid := subtle.ConstantTimeCompare(derived, record.hash) & subtle.ConstantTimeCompare([]byte(username), []byte(Username))
	Erase(derived)
	if valid != 1 {
		return LoginResult{}, failure("INVALID_CREDENTIALS")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return LoginResult{}, failure("AUTH_UNAVAILABLE")
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	Erase(random[:])
	digest := sha256.Sum256([]byte(token))
	session := Session{Username: Username, ExpiresAt: m.now().UTC().Add(SessionLifetime)}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Keep storage bounded and revoke the oldest session when a ninth login
	// succeeds. A restart naturally discards all entries.
	if len(m.sessions) >= maxSessions {
		var oldest [32]byte
		var oldestTime time.Time
		for key, value := range m.sessions {
			if oldestTime.IsZero() || value.issuedAt.Before(oldestTime) {
				oldest, oldestTime = key, value.issuedAt
			}
		}
		delete(m.sessions, oldest)
	}
	m.sessions[digest] = storedSession{Session: session, issuedAt: m.now().UTC()}
	return LoginResult{SessionToken: token, Username: Username, ExpiresAt: session.ExpiresAt}, nil
}

func tokenDigest(token string) ([32]byte, bool) {
	var zero [32]byte
	if len(token) != 43 {
		return zero, false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return zero, false
	}
	Erase(decoded)
	return sha256.Sum256([]byte(token)), true
}
func (m *Manager) Validate(token string) (Session, error) {
	if !m.Initialized() {
		return Session{}, failure("AUTH_NOT_INITIALIZED")
	}
	digest, ok := tokenDigest(token)
	if !ok {
		return Session{}, failure("AUTH_REQUIRED")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, exists := m.sessions[digest]
	if !exists {
		return Session{}, failure("AUTH_REQUIRED")
	}
	if !m.now().UTC().Before(session.ExpiresAt) {
		return Session{}, failure("SESSION_EXPIRED")
	}
	return session.Session, nil
}
func (m *Manager) Logout(token string) error {
	if _, err := m.Validate(token); err != nil {
		return err
	}
	digest, _ := tokenDigest(token)
	m.mu.Lock()
	delete(m.sessions, digest)
	m.mu.Unlock()
	return nil
}
