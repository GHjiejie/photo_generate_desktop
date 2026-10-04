// Package store implements the single-writer durable portrait library.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	MaxImage     = 30 << 20
	MaxIndex     = 32 << 20
	MaxRecords   = 500
	MaxItems     = 10000
	MaxBatch     = 1 << 30
	MaxDimension = 12000
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string        { return e.Code + ": " + e.Message }
func fail(code, message string) error { return &Error{code, message} }
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "IO_ERROR"
}

type Prompts struct {
	EN string `json:"en"`
	ZH string `json:"zh"`
}
type Item struct {
	ID             int             `json:"id"`
	Label          string          `json:"label"`
	Type           string          `json:"type"`
	Prompts        Prompts         `json:"prompts"`
	Image          string          `json:"image"`
	ImageRel       string          `json:"imageRel"`
	Revision       int64           `json:"revision"`
	SHA256         string          `json:"sha256"`
	Size           int64           `json:"size"`
	MIME           string          `json:"mime"`
	SourceMetadata json.RawMessage `json:"sourceMetadata,omitempty"`
	SourceImport   json.RawMessage `json:"sourceImport,omitempty"`
}
type Snapshot struct {
	SchemaVersion int    `json:"schemaVersion"`
	Revision      int64  `json:"revision"`
	UpdatedAt     string `json:"updatedAt"`
	Items         []Item `json:"items"`
}
type Metadata struct {
	ID      int     `json:"id"`
	Label   string  `json:"label"`
	Type    string  `json:"type"`
	Prompts Prompts `json:"prompts"`
}
type CreateInput struct {
	Context context.Context `json:"-"`
	Metadata
	ExpectedVersion int64  `json:"expectedVersion"`
	Image           []byte `json:"-"`
}
type UpdateInput struct {
	Context context.Context `json:"-"`
	Metadata
	ExpectedVersion  int64  `json:"expectedVersion"`
	ExpectedRevision int64  `json:"expectedRevision"`
	Image            []byte `json:"-"`
}
type DeleteInput struct {
	Context          context.Context `json:"-"`
	ID               int             `json:"id"`
	ExpectedVersion  int64           `json:"expectedVersion"`
	ExpectedRevision int64           `json:"expectedRevision"`
	Confirmed        bool            `json:"confirmed"`
}
type MutationResult struct {
	Revision   int64  `json:"revision"`
	Item       *Item  `json:"item,omitempty"`
	DeletedID  int    `json:"deletedId,omitempty"`
	RecoveryID string `json:"recoveryId,omitempty"`
}
type ImageResult struct {
	Bytes    []byte `json:"-"`
	MIME     string `json:"mime"`
	SHA256   string `json:"sha256"`
	Revision int64  `json:"revision"`
}

// Images holds uploaded file bytes; ImagePaths holds trusted server staging paths.
// Clients never supply ImagePaths. Both are copied and verified during preview.
type BatchInput struct {
	Context               context.Context   `json:"-"`
	Manifest              []byte            `json:"-"`
	ManifestName          string            `json:"manifestName"`
	Images                map[string][]byte `json:"-"`
	ImagePaths            map[string]string `json:"-"`
	Type                  string            `json:"type"`
	CollisionPolicy       string            `json:"collisionPolicy"`
	DerivedChinesePrompts map[string]string `json:"derivedChinesePrompts,omitempty"`
}
type Issue struct {
	Code               string `json:"code"`
	Severity           string `json:"severity"`
	RecordIndex        *int   `json:"recordIndex,omitempty"`
	ID                 int    `json:"id,omitempty"`
	SourceFileName     string `json:"sourceFileName,omitempty"`
	SourceRelativePath string `json:"sourceRelativePath,omitempty"`
}
type BatchRow struct {
	Index              int      `json:"index"`
	ID                 int      `json:"id,omitempty"`
	TargetID           int      `json:"targetId,omitempty"`
	Label              string   `json:"label"`
	Status             string   `json:"status"`
	SourceFileName     string   `json:"sourceFileName,omitempty"`
	SourceRelativePath string   `json:"sourceRelativePath,omitempty"`
	IssueCodes         []string `json:"issueCodes"`
	MatchMethod        string   `json:"matchMethod,omitempty"`
}
type BatchCounts struct {
	Total      int `json:"total"`
	Matched    int `json:"matched"`
	Importable int `json:"importable"`
	Errors     int `json:"errors"`
	Unmatched  int `json:"unmatched"`
	Unpaired   int `json:"unpaired"`
	Imported   int `json:"imported"`
	Skipped    int `json:"skipped"`
	Conflicts  int `json:"conflicts"`
}
type BatchPreview struct {
	PreviewID      string      `json:"previewId"`
	Revision       int64       `json:"revision"`
	ExpiresAt      string      `json:"expiresAt"`
	Counts         BatchCounts `json:"counts"`
	Items          []BatchRow  `json:"items"`
	Issues         []Issue     `json:"issues"`
	Unpaired       []Issue     `json:"unpaired"`
	ManifestSHA256 string      `json:"manifestSha256"`
}
type CommitBatchInput struct {
	Context         context.Context `json:"-"`
	PreviewID       string          `json:"previewId"`
	ExpectedVersion int64           `json:"expectedVersion"`
	Confirmed       bool            `json:"confirmed"`
}
type BatchResult struct {
	Revision   int64       `json:"revision"`
	Imported   int         `json:"imported"`
	Skipped    int         `json:"skipped"`
	ArchiveRel string      `json:"archiveRel,omitempty"`
	Counts     BatchCounts `json:"counts"`
	Items      []BatchRow  `json:"items"`
}

func utcNow() string                          { return time.Now().UTC().Format(time.RFC3339Nano) }
func idName(id int, token, ext string) string { return fmt.Sprintf("%06d-%s.%s", id, token, ext) }
