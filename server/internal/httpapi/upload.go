package httpapi

import (
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"

	"portraitstudio/server/internal/store"
)

func partBytes(part *multipart.Part, limit int64) ([]byte, error) {
	if part.Header.Get("Content-Transfer-Encoding") != "" {
		return nil, problem("INVALID_INPUT", "Encoded multipart parts are not supported.")
	}
	return readLimited(part, limit)
}
func (a *API) readMutation(w http.ResponseWriter, r *http.Request, requiredImage bool) ([]byte, []byte, error) {
	if err := a.reserve(r.Context()); err != nil {
		return nil, nil, err
	}
	defer func() { <-a.uploads }()
	if !requiredImage && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := contentType(r, "application/json"); err != nil {
			return nil, nil, err
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		metadata, err := readLimited(r.Body, 1<<20)
		return metadata, nil, err
	}
	if err := contentType(r, "multipart/form-data"); err != nil {
		return nil, nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxImage+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, nil, problem("INVALID_INPUT", "The multipart body is invalid.")
	}
	var metadata, image []byte
	seen := map[string]bool{}
	for count := 0; ; count++ {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, problem("INVALID_INPUT", "The multipart body is incomplete.")
		}
		name := part.FormName()
		if count >= 2 || seen[name] || name != "metadata" && name != "image" {
			return nil, nil, problem("INVALID_INPUT", "Multipart requires unique metadata and image fields only.")
		}
		seen[name] = true
		if name == "metadata" {
			metadata, err = partBytes(part, 1<<20)
		} else {
			image, err = partBytes(part, store.MaxImage)
		}
		if err != nil {
			return nil, nil, err
		}
		if err = part.Close(); err != nil {
			return nil, nil, problem("INVALID_INPUT", "The multipart part is incomplete.")
		}
	}
	if !seen["metadata"] || requiredImage && !seen["image"] || seen["image"] && len(image) == 0 {
		return nil, nil, problem("INVALID_INPUT", "Required upload fields are missing or empty.")
	}
	return metadata, image, nil
}

type batchMetadata struct {
	ManifestRelativePath  string            `json:"manifestRelativePath"`
	ExpectedVersion       *int64            `json:"expectedVersion,omitempty"`
	Type                  string            `json:"type"`
	CollisionPolicy       string            `json:"collisionPolicy"`
	DerivedChinesePrompts map[string]string `json:"derivedChinesePrompts,omitempty"`
}

func (a *API) preview(w http.ResponseWriter, r *http.Request) (any, error) {
	if err := a.reserve(r.Context()); err != nil {
		return nil, err
	}
	defer func() { <-a.uploads }()
	if err := contentType(r, "multipart/form-data"); err != nil {
		return nil, err
	}
	directory, err := a.uploadDirectory()
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxBatch+(64<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, problem("INVALID_INPUT", "The multipart body is invalid.")
	}
	var rawMetadata, manifest []byte
	images := make(map[string]string)
	seen := make(map[string]bool)
	var total int64
	for count := 0; ; count++ {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, problem("INVALID_INPUT", "The multipart body is incomplete.")
		}
		name := part.FormName()
		if count >= store.MaxRecords+2 || seen[name] {
			return nil, problem("INVALID_INPUT", "Multipart fields must be unique and limited to 500 images, one manifest and one metadata part.")
		}
		seen[name] = true
		switch {
		case name == "metadata":
			rawMetadata, err = partBytes(part, store.MaxIndex)
		case name == "manifest":
			manifest, err = partBytes(part, store.MaxIndex)
		case strings.HasPrefix(name, "image:"):
			relative := strings.TrimPrefix(name, "image:")
			if !safeRelative(relative) {
				return nil, problem("UNSAFE_PATH", "An uploaded image relative path is invalid.")
			}
			if part.Header.Get("Content-Transfer-Encoding") != "" {
				return nil, problem("INVALID_INPUT", "Encoded multipart parts are not supported.")
			}
			file, fileErr := os.CreateTemp(directory, "image-")
			if fileErr != nil {
				return nil, problem("IO_ERROR", "Could not stage an uploaded image.")
			}
			written, copyErr := io.Copy(file, io.LimitReader(part, store.MaxImage+1))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil {
				return nil, problem("INVALID_INPUT", "An uploaded image is incomplete.")
			}
			if written < 1 || written > store.MaxImage {
				return nil, problem("TOO_LARGE", "An uploaded image must be non-empty and at most 30 MiB.")
			}
			total += written
			if total > store.MaxBatch {
				return nil, problem("TOO_LARGE", "Batch images may total at most 1 GiB.")
			}
			images[relative] = file.Name()
		default:
			return nil, problem("INVALID_INPUT", "The multipart body contains an unsupported field.")
		}
		if err != nil {
			return nil, err
		}
		if err = part.Close(); err != nil {
			return nil, problem("INVALID_INPUT", "A multipart part is incomplete.")
		}
	}
	if !seen["metadata"] || !seen["manifest"] {
		return nil, problem("INVALID_INPUT", "A batch requires metadata and the original JSON manifest.")
	}
	var metadata batchMetadata
	if err = decodeStrict(rawMetadata, &metadata); err != nil {
		return nil, err
	}
	if !safeRelative(metadata.ManifestRelativePath) || !strings.HasSuffix(strings.ToLower(metadata.ManifestRelativePath), ".json") {
		return nil, problem("UNSAFE_PATH", "The manifest relative path must be a safe JSON filename.")
	}
	if metadata.Type != "photo" && metadata.Type != "art" {
		return nil, problem("INVALID_INPUT", "The batch type must be photo or art.")
	}
	if metadata.CollisionPolicy != "" && metadata.CollisionPolicy != "conflict" && metadata.CollisionPolicy != "allocate-new" {
		return nil, problem("INVALID_INPUT", "The batch collision policy is unsupported.")
	}
	if len(metadata.DerivedChinesePrompts) > store.MaxRecords {
		return nil, problem("TOO_MANY_RECORDS", "A batch supports at most 500 derived translations.")
	}
	for id, prompt := range metadata.DerivedChinesePrompts {
		if _, err = parseID(id); err != nil {
			return nil, problem("INVALID_INPUT", "Derived translations must be keyed by unique source IDs.")
		}
		if strings.TrimSpace(prompt) == "" || promptLength(prompt) > 65536 || strings.ContainsRune(prompt, 0) {
			return nil, problem("INVALID_INPUT", "A derived Chinese prompt is invalid.")
		}
	}
	if err = validateJSON(manifest); err != nil {
		return nil, err
	}
	if metadata.ExpectedVersion != nil {
		snapshot, e := a.backend.List()
		if e != nil {
			return nil, e
		}
		if *metadata.ExpectedVersion != snapshot.Revision {
			return nil, problem("CONFLICT", "The library changed; refresh before preparing the batch.")
		}
	}
	if err = canceled(r.Context()); err != nil {
		return nil, err
	}
	preview, err := a.backend.PreviewBatch(store.BatchInput{Context: r.Context(), Manifest: manifest, ManifestName: metadata.ManifestRelativePath, ImagePaths: images, Type: metadata.Type, CollisionPolicy: metadata.CollisionPolicy, DerivedChinesePrompts: metadata.DerivedChinesePrompts})
	if err != nil {
		return nil, err
	}
	if err = canceled(r.Context()); err != nil {
		_ = a.backend.CancelBatch(preview.PreviewID)
		return nil, err
	}
	// Keep both detailed counts and the existing desktop dialog's flat counters.
	return map[string]any{"previewId": preview.PreviewID, "root": a.options.LibraryLabel, "revision": preview.Revision, "expiresAt": preview.ExpiresAt, "manifestSha256": preview.ManifestSHA256, "counts": preview.Counts, "total": preview.Counts.Total, "matched": preview.Counts.Matched, "importable": preview.Counts.Importable, "skipped": preview.Counts.Skipped, "conflicts": preview.Counts.Conflicts, "items": nonNilRows(preview.Items), "issues": nonNilIssues(preview.Issues), "unpaired": nonNilIssues(preview.Unpaired), "canImport": preview.Counts.Importable > 0}, nil
}
func nonNilRows(rows []store.BatchRow) []store.BatchRow {
	if rows == nil {
		return []store.BatchRow{}
	}
	return rows
}
func nonNilIssues(issues []store.Issue) []store.Issue {
	if issues == nil {
		return []store.Issue{}
	}
	return issues
}
