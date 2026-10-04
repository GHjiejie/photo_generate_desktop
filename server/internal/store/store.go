package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	_ "golang.org/x/image/webp"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"path"
	"strings"
	"unicode/utf16"
)

type imageInfo struct {
	mime, ext, sha string
	size           int64
}

func inspectImage(b []byte) (imageInfo, error) {
	if len(b) == 0 || len(b) > MaxImage {
		return imageInfo{}, fail("IMAGE_TOO_LARGE", "Image must be 1 byte to 30 MiB")
	}
	c, format, e := image.DecodeConfig(bytes.NewReader(b))
	if e != nil || c.Width < 1 || c.Height < 1 || c.Width > MaxDimension || c.Height > MaxDimension || int64(c.Width)*int64(c.Height) > 100000000 {
		return imageInfo{}, fail("INVALID_IMAGE", "Image is invalid or exceeds 12000 pixels / 100 million pixels")
	}
	mime, ext := "", ""
	switch format {
	case "png":
		mime, ext = "image/png", "png"
	case "jpeg":
		mime, ext = "image/jpeg", "jpg"
	case "webp":
		mime, ext = "image/webp", "webp"
	default:
		return imageInfo{}, fail("INVALID_IMAGE", "Only PNG, JPEG and WebP are supported")
	}
	decoded, actual, e := image.Decode(bytes.NewReader(b))
	if e != nil || actual != format || decoded.Bounds().Dx() != c.Width || decoded.Bounds().Dy() != c.Height {
		return imageInfo{}, fail("INVALID_IMAGE", "Image cannot be fully decoded")
	}
	return imageInfo{mime, ext, digest(b), int64(len(b))}, nil
}
func textLength(s string) int    { return len(utf16.Encode([]rune(s))) }
func validID(id int) bool        { return id >= 1 && id <= 999999 }
func validRevision(v int64) bool { return v >= 1 && v <= 9007199254740991 }
func validateMetadata(m Metadata) error {
	if !validID(m.ID) || strings.TrimSpace(m.Label) == "" || textLength(m.Label) > 160 {
		return fail("INVALID_DATA", "Valid ID and a label of at most 160 characters are required")
	}
	for _, r := range m.Label {
		if r < 32 || r == 127 {
			return fail("INVALID_DATA", "Label contains a control character")
		}
	}
	if m.Type != "photo" && m.Type != "art" {
		return fail("INVALID_TYPE", "Type must be photo or art")
	}
	for _, p := range []string{m.Prompts.EN, m.Prompts.ZH} {
		if strings.TrimSpace(p) == "" || textLength(p) > 65536 || strings.ContainsRune(p, 0) {
			return fail("INVALID_DATA", "Complete English and Chinese prompts are required (max 65536 characters each)")
		}
	}
	return nil
}
func metadataOf(i Item) Metadata { return Metadata{i.ID, i.Label, i.Type, i.Prompts} }
func validateSnapshot(v Snapshot) error {
	if v.SchemaVersion != 1 || !validRevision(v.Revision) || v.Items == nil || len(v.Items) > MaxItems {
		return fail("INVALID_DATA", "Invalid library index")
	}
	ids := map[int]bool{}
	images := map[string]bool{}
	for _, i := range v.Items {
		if e := validateMetadata(metadataOf(i)); e != nil {
			return e
		}
		if ids[i.ID] || images[i.ImageRel] {
			return fail("INVALID_DATA", "Duplicate index ID or image")
		}
		ids[i.ID] = true
		images[i.ImageRel] = true
		if !validRevision(i.Revision) || !imagePattern.MatchString(i.ImageRel) || i.Image != path.Base(i.ImageRel) || !hashPattern.MatchString(i.SHA256) || i.Size < 1 || i.Size > MaxImage {
			return fail("INVALID_DATA", "Invalid indexed image metadata")
		}
		if !extensionMatches(i.Image, i.MIME) {
			return fail("INVALID_DATA", "Image format differs from its extension")
		}
		if len(i.SourceMetadata) > 0 || len(i.SourceImport) > 0 {
			var raw map[string]json.RawMessage
			var source map[string]json.RawMessage
			if json.Unmarshal(i.SourceMetadata, &raw) != nil || raw == nil || json.Unmarshal(i.SourceImport, &source) != nil || source == nil {
				return fail("INVALID_DATA", "Invalid source metadata")
			}
			var archive, manifest, hash, name, typ, rel string
			var ri int
			json.Unmarshal(source["archiveRel"], &archive)
			json.Unmarshal(source["manifestSha256"], &manifest)
			json.Unmarshal(source["sourceHash"], &hash)
			json.Unmarshal(source["sourceFileName"], &name)
			json.Unmarshal(source["recordIndex"], &ri)
			json.Unmarshal(source["typeOrigin"], &typ)
			if !strings.HasPrefix(archive, meta+"/imports/") || !tokenPattern.MatchString(strings.TrimPrefix(archive, meta+"/imports/")) || !hashPattern.MatchString(manifest) || !hashPattern.MatchString(hash) || ri < 0 || ri >= MaxRecords || !safeRelative(name) || strings.Contains(name, "/") || (typ != "source" && typ != "selected-default") {
				return fail("INVALID_DATA", "Invalid import provenance")
			}
			if rawrel, ok := source["sourceRelativePath"]; ok {
				if json.Unmarshal(rawrel, &rel) != nil || !safeRelative(rel) || path.Base(rel) != name {
					return fail("INVALID_DATA", "Invalid source relative path")
				}
			}
			if sid, ok := source["sourceId"]; ok {
				var id int
				if json.Unmarshal(sid, &id) != nil || !validID(id) || recordID(raw["id"]) != id {
					return fail("INVALID_DATA", "Source ID differs from the raw record")
				}
			}
			if _, ok := source["translationProvenance"]; ok {
				if e := validateProvenance(raw, source); e != nil {
					return e
				}
			} else if _, ok := source["derivedChinesePrompt"]; ok {
				return fail("INVALID_DATA", "Derived prompt has no provenance")
			}
		}
	}
	return nil
}
func extensionMatches(name, mime string) bool {
	ext := strings.ToLower(path.Ext(name))
	switch mime {
	case "image/png":
		return ext == ".png"
	case "image/jpeg":
		return ext == ".jpg" || ext == ".jpeg"
	case "image/webp":
		return ext == ".webp"
	}
	return false
}
func (s *Store) load(fresh bool) (Snapshot, []byte, error) {
	b, e := s.read(indexRel, MaxIndex)
	if e != nil {
		return Snapshot{}, nil, e
	}
	h := digest(b)
	if !fresh && s.indexHash != "" && s.indexHash != h {
		return Snapshot{}, nil, fail("CONFLICT", "Library index changed outside the server")
	}
	var idx Snapshot
	if json.Unmarshal(b, &idx) != nil {
		return idx, nil, fail("INVALID_DATA", "Index is not valid JSON")
	}
	if e = validateSnapshot(idx); e != nil {
		return idx, nil, e
	}
	s.indexHash = h
	return idx, b, nil
}
func (s *Store) List() (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, _, e := s.load(false)
	return cloneSnapshot(v), e
}
func findItem(idx Snapshot, id int) (Item, int, error) {
	if !validID(id) {
		return Item{}, -1, fail("INVALID_DATA", "Invalid ID")
	}
	for n, i := range idx.Items {
		if i.ID == id {
			return i, n, nil
		}
	}
	return Item{}, -1, fail("NOT_FOUND", "Portrait no longer exists")
}
func (s *Store) Get(id int) (Item, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, _, e := s.load(false)
	if e != nil {
		return Item{}, 0, e
	}
	item, _, e := findItem(idx, id)
	return item, idx.Revision, e
}
func (s *Store) ReadImage(id int) (ImageResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, _, e := s.load(false)
	if e != nil {
		return ImageResult{}, e
	}
	i, _, e := findItem(idx, id)
	if e != nil {
		return ImageResult{}, e
	}
	b, e := s.read(i.ImageRel, MaxImage)
	if e != nil {
		return ImageResult{}, e
	}
	if int64(len(b)) != i.Size || digest(b) != i.SHA256 {
		return ImageResult{}, fail("CONFLICT", "Image changed outside the server")
	}
	return ImageResult{b, i.MIME, i.SHA256, i.Revision}, nil
}
func compare(idx Snapshot, version int64, item *Item, revision int64) error {
	if !validRevision(version) || version != idx.Revision || item != nil && (!validRevision(revision) || revision != item.Revision) {
		return fail("CONFLICT", "Portrait changed; refresh before editing")
	}
	return nil
}
func (s *Store) Create(in CreateInput) (MutationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operationContext = in.Context
	defer func() { s.operationContext = nil }()
	if e := s.contextErr(); e != nil {
		return MutationResult{}, e
	}
	idx, before, e := s.load(false)
	if e != nil {
		return MutationResult{}, e
	}
	if e = compare(idx, in.ExpectedVersion, nil, 0); e != nil {
		return MutationResult{}, e
	}
	if e = validateMetadata(in.Metadata); e != nil {
		return MutationResult{}, e
	}
	if len(idx.Items) >= MaxItems {
		return MutationResult{}, fail("LIBRARY_TOO_LARGE", "Library limit is 10000 portraits")
	}
	if _, _, e = findItem(idx, in.ID); e == nil {
		return MutationResult{}, fail("CONFLICT", "ID already exists")
	}
	im, e := inspectImage(in.Image)
	if e != nil {
		return MutationResult{}, e
	}
	id := token()
	imageName := idName(in.ID, id, im.ext)
	item := Item{ID: in.ID, Label: in.Label, Type: in.Type, Prompts: in.Prompts, Image: imageName, ImageRel: "assets/images/" + imageName, Revision: 1, SHA256: im.sha, Size: im.size, MIME: im.mime}
	after := cloneSnapshot(idx)
	after.Revision++
	after.UpdatedAt = utcNow()
	after.Items = append(after.Items, item)
	if e = s.transact(id, before, after, []installBytes{{item.ImageRel, in.Image}}, nil); e != nil {
		return MutationResult{}, e
	}
	return MutationResult{Revision: after.Revision, Item: &item}, nil
}
func (s *Store) Update(in UpdateInput) (MutationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operationContext = in.Context
	defer func() { s.operationContext = nil }()
	if e := s.contextErr(); e != nil {
		return MutationResult{}, e
	}
	idx, before, e := s.load(false)
	if e != nil {
		return MutationResult{}, e
	}
	old, n, e := findItem(idx, in.ID)
	if e != nil {
		return MutationResult{}, e
	}
	if e = compare(idx, in.ExpectedVersion, &old, in.ExpectedRevision); e != nil {
		return MutationResult{}, e
	}
	if e = validateMetadata(in.Metadata); e != nil {
		return MutationResult{}, e
	}
	item := old
	item.Label = in.Label
	item.Type = in.Type
	item.Prompts = in.Prompts
	item.Revision++
	id := token()
	installs := []installBytes{}
	removes := []removeEntry{}
	recoveryID := ""
	if in.Image != nil {
		im, e := inspectImage(in.Image)
		if e != nil {
			return MutationResult{}, e
		}
		if im.sha != old.SHA256 {
			oldBytes, e := s.read(old.ImageRel, MaxImage)
			if e != nil {
				return MutationResult{}, e
			}
			if digest(oldBytes) != old.SHA256 {
				return MutationResult{}, fail("CONFLICT", "Original image changed")
			}
			recoveryID = id
			if e = s.mkdir(meta + "/recovery/" + id); e != nil {
				return MutationResult{}, e
			}
			oldRecord, _ := encode(old)
			installs = append(installs, installBytes{meta + "/recovery/" + id + "/item.json", oldRecord}, installBytes{meta + "/recovery/" + id + "/" + old.Image, oldBytes})
			removes = append(removes, removeEntry{old.ImageRel, old.SHA256})
			item.Image = idName(in.ID, id, im.ext)
			item.ImageRel = "assets/images/" + item.Image
			item.SHA256 = im.sha
			item.Size = im.size
			item.MIME = im.mime
			installs = append(installs, installBytes{item.ImageRel, in.Image})
		}
	}
	after := cloneSnapshot(idx)
	after.Items[n] = item
	after.Revision++
	after.UpdatedAt = utcNow()
	if e = s.transact(id, before, after, installs, removes); e != nil {
		return MutationResult{}, e
	}
	return MutationResult{Revision: after.Revision, Item: &item, RecoveryID: recoveryID}, nil
}
func (s *Store) Delete(in DeleteInput) (MutationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operationContext = in.Context
	defer func() { s.operationContext = nil }()
	if e := s.contextErr(); e != nil {
		return MutationResult{}, e
	}
	if !in.Confirmed {
		return MutationResult{}, fail("CONFIRMATION_REQUIRED", "Deletion requires confirmation")
	}
	idx, before, e := s.load(false)
	if e != nil {
		return MutationResult{}, e
	}
	old, n, e := findItem(idx, in.ID)
	if e != nil {
		return MutationResult{}, e
	}
	if e = compare(idx, in.ExpectedVersion, &old, in.ExpectedRevision); e != nil {
		return MutationResult{}, e
	}
	b, e := s.read(old.ImageRel, MaxImage)
	if e != nil {
		return MutationResult{}, e
	}
	if digest(b) != old.SHA256 {
		return MutationResult{}, fail("CONFLICT", "Image changed")
	}
	id := token()
	if e = s.mkdir(meta + "/recovery/" + id); e != nil {
		return MutationResult{}, e
	}
	raw, _ := encode(old)
	after := cloneSnapshot(idx)
	after.Items = append(after.Items[:n], after.Items[n+1:]...)
	after.Revision++
	after.UpdatedAt = utcNow()
	if e = s.transact(id, before, after, []installBytes{{meta + "/recovery/" + id + "/item.json", raw}, {meta + "/recovery/" + id + "/" + old.Image, b}}, []removeEntry{{old.ImageRel, old.SHA256}}); e != nil {
		return MutationResult{}, e
	}
	return MutationResult{Revision: after.Revision, DeletedID: in.ID, RecoveryID: id}, nil
}
func checkIndexSize(idx Snapshot) ([]byte, error) {
	if e := validateSnapshot(idx); e != nil {
		return nil, e
	}
	b, e := encode(idx)
	if e != nil {
		return nil, e
	}
	if len(b) > MaxIndex {
		return nil, fail("LIBRARY_TOO_LARGE", fmt.Sprintf("Index exceeds %d bytes", MaxIndex))
	}
	return b, nil
}
