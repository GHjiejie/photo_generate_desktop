package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type stagedImage struct {
	relative, stage string
	info            imageInfo
}
type batchRecord struct {
	sourceID, index   int
	metadata          Metadata
	raw               json.RawMessage
	image             *stagedImage
	match, typeOrigin string
	provenance        map[string]any
}
type batchPlan struct {
	preview       BatchPreview
	records       []batchRecord
	stage, policy string
	expires       time.Time
	manifest      []byte
	manifestName  string
	size          int64
}

var leadingPattern = regexp.MustCompile(`^(\d{1,6})[-_](.+)$`)

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func recordID(raw json.RawMessage) int {
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		v, e := strconv.Atoi(string(n))
		if e == nil && validID(v) {
			return v
		}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && len(s) <= 6 {
		for _, c := range s {
			if c < '0' || c > '9' {
				return 0
			}
		}
		v, e := strconv.Atoi(s)
		if e == nil && validID(v) {
			return v
		}
	}
	return 0
}
func leadingID(name string) int {
	m := leadingPattern.FindStringSubmatch(name)
	if m == nil {
		return 0
	}
	v, _ := strconv.Atoi(m[1])
	if validID(v) {
		return v
	}
	return 0
}
func recordPrompt(raw map[string]json.RawMessage, fields ...string) (value, field string, invalid bool) {
	for _, f := range fields {
		b, ok := raw[f]
		if strings.HasPrefix(f, "prompts.") {
			var p map[string]json.RawMessage
			json.Unmarshal(raw["prompts"], &p)
			b, ok = p[strings.TrimPrefix(f, "prompts.")]
		}
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(b, &s) != nil || strings.TrimSpace(s) == "" || textLength(s) > 65536 || strings.ContainsRune(s, 0) {
			return "", f, true
		}
		return s, f, false
	}
	return "", "", false
}
func extractRecords(manifest []byte) ([]json.RawMessage, error) {
	if len(manifest) == 0 || len(manifest) > MaxIndex {
		return nil, fail("INVALID_MANIFEST", "Manifest must be between 1 byte and 32 MiB")
	}
	trim := bytes.TrimSpace(manifest)
	if !json.Valid(trim) {
		return nil, fail("INVALID_MANIFEST", "Manifest is not valid JSON")
	}
	var rows []json.RawMessage
	if len(trim) > 0 && trim[0] == '[' {
		if e := json.Unmarshal(trim, &rows); e != nil {
			return nil, fail("INVALID_MANIFEST", "Manifest array is invalid")
		}
	} else {
		var wrapper map[string]json.RawMessage
		if json.Unmarshal(trim, &wrapper) != nil || json.Unmarshal(wrapper["images"], &rows) != nil {
			return nil, fail("INVALID_MANIFEST", "Expected an array or an object containing an images array")
		}
	}
	if rows == nil || len(rows) > MaxRecords {
		return nil, fail("INVALID_MANIFEST", "Manifest must contain at most 500 records")
	}
	return rows, nil
}
func imageExtension(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".webp":
		return true
	}
	return false
}
func manifestImageName(raw map[string]json.RawMessage) (string, string) {
	name := ""
	found := false
	for _, f := range []string{"image", "filename", "fileName", "image_file"} {
		b, ok := raw[f]
		if !ok {
			continue
		}
		var v string
		if json.Unmarshal(b, &v) != nil || !safeRelative(v) || !imageExtension(v) {
			return "", "INVALID_IMAGE_NAME"
		}
		if found && name != v {
			return "", "INVALID_IMAGE_NAME"
		}
		name = v
		found = true
	}
	return name, ""
}
func externalRead(name string, limit int64) ([]byte, error) {
	pi, e := noLinkAbsolute(name)
	if e != nil {
		return nil, e
	}
	if !pi.Mode().IsRegular() || pi.Size() < 1 || pi.Size() > limit {
		return nil, fail("INVALID_IMAGE", "Uploaded image is not a bounded regular file")
	}
	f, e := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	before, e := f.Stat()
	if e != nil || !os.SameFile(pi, before) {
		return nil, fail("SOURCE_CHANGED", "Upload staging was replaced")
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	pi, pe := noLinkAbsolute(name)
	if e != nil || pe != nil || !os.SameFile(before, pi) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || int64(len(b)) != before.Size() || int64(len(b)) > limit {
		return nil, fail("SOURCE_CHANGED", "Upload staging changed")
	}
	return b, nil
}
func (s *Store) prunePreviews() error {
	for id, p := range s.previews {
		if time.Now().After(p.expires) {
			if e := s.removeOwnedTree(p.stage); e != nil {
				return e
			}
			delete(s.previews, id)
		}
	}
	return nil
}
func (s *Store) PreviewBatch(in BatchInput) (preview BatchPreview, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operationContext = in.Context
	defer func() { s.operationContext = nil }()
	if e := s.contextErr(); e != nil {
		return preview, e
	}
	if e := s.prunePreviews(); e != nil {
		return preview, e
	}
	if len(s.previews) >= 64 {
		return preview, fail("LIBRARY_BUSY", "At most 64 active batch previews")
	}
	idx, _, e := s.load(false)
	if e != nil {
		return preview, e
	}
	if in.Type == "" {
		in.Type = "photo"
	}
	if in.Type != "photo" && in.Type != "art" {
		return preview, fail("INVALID_TYPE", "Batch type must be photo or art")
	}
	if in.CollisionPolicy == "" {
		in.CollisionPolicy = "conflict"
	}
	if in.CollisionPolicy != "conflict" && in.CollisionPolicy != "allocate-new" {
		return preview, fail("INVALID_INPUT", "Unknown collision policy")
	}
	if in.ManifestName == "" {
		in.ManifestName = "manifest.json"
	}
	if !safeRelative(in.ManifestName) || len(strings.Split(in.ManifestName, "/")) > 4 || strings.ToLower(path.Ext(in.ManifestName)) != ".json" {
		return preview, fail("INVALID_MANIFEST", "Invalid manifest relative path")
	}
	rows, e := extractRecords(in.Manifest)
	if e != nil {
		return preview, e
	}
	if len(in.Images)+len(in.ImagePaths) > 5000 {
		return preview, fail("DIRECTORY_TOO_LARGE", "Upload exceeds 5000 entries")
	}
	keys := map[string]bool{}
	for k := range in.Images {
		keys[k] = true
	}
	for k := range in.ImagePaths {
		if keys[k] {
			return preview, fail("INVALID_SOURCE", "Same image supplied twice")
		}
		keys[k] = true
	}
	for k := range keys {
		if !safeRelative(k) || len(strings.Split(k, "/")) > 4 || !imageExtension(k) {
			return preview, fail("UNSAFE_PATH", "Images must have safe paths within three subdirectory levels")
		}
	}
	rawMaps := make([]map[string]json.RawMessage, len(rows))
	ids := make([]int, len(rows))
	names := make([]string, len(rows))
	nameErrors := make([]string, len(rows))
	idCounts := map[int]int{}
	nameCounts := map[string]int{}
	for n, row := range rows {
		json.Unmarshal(row, &rawMaps[n])
		if rawMaps[n] != nil {
			ids[n] = recordID(rawMaps[n]["id"])
			names[n], nameErrors[n] = manifestImageName(rawMaps[n])
		}
		if ids[n] != 0 {
			idCounts[ids[n]]++
		}
		if names[n] != "" {
			nameCounts[names[n]]++
		}
	}
	if in.DerivedChinesePrompts != nil {
		eligible := map[string]bool{}
		for n, raw := range rawMaps {
			if ids[n] == 0 || idCounts[ids[n]] != 1 {
				return preview, fail("INVALID_TRANSLATION", "Translations require unique valid source IDs")
			}
			en, _, _ := recordPrompt(raw, "prompt_en", "prompt", "prompts.en")
			zh, _, invalid := recordPrompt(raw, "prompt_cn", "prompt_zh", "prompts.zh")
			if en != "" && zh == "" && !invalid {
				eligible[strconv.Itoa(ids[n])] = true
			}
		}
		if len(eligible) != len(in.DerivedChinesePrompts) {
			return preview, fail("INVALID_TRANSLATION", "Translations must cover exactly records lacking Chinese")
		}
		for id, zh := range in.DerivedChinesePrompts {
			if !eligible[id] || strings.TrimSpace(zh) == "" || textLength(zh) > 65536 || strings.ContainsRune(zh, 0) {
				return preview, fail("INVALID_TRANSLATION", "Invalid derived Chinese prompt")
			}
		}
	}
	previewID := token()
	stage := meta + "/go-staging/" + previewID
	if e = s.mkdir(stage); e != nil {
		return preview, e
	}
	success := false
	defer func() {
		if !success {
			s.removeOwnedTree(stage)
		}
	}()
	if e = s.writeExclusive(stage+"/manifest.json", in.Manifest); e != nil {
		return preview, e
	}
	plan := &batchPlan{stage: stage, policy: in.CollisionPolicy, expires: time.Now().Add(30 * time.Minute), manifest: append([]byte(nil), in.Manifest...), manifestName: in.ManifestName, size: int64(len(in.Manifest))}
	preview = BatchPreview{PreviewID: previewID, Revision: idx.Revision, ExpiresAt: plan.expires.UTC().Format(time.RFC3339Nano), Counts: BatchCounts{Total: len(rows)}, Items: []BatchRow{}, Issues: []Issue{}, Unpaired: []Issue{}, ManifestSHA256: digest(in.Manifest)}
	used := map[string]bool{}
	catalog := map[string]*stagedImage{}
	var total int64
	var pending int64
	for _, p := range s.previews {
		pending += p.size
	}
	for n, k := range sortedKeys(keys) {
		if e := s.contextErr(); e != nil {
			return preview, e
		}
		var b []byte
		if v, ok := in.Images[k]; ok {
			b = append([]byte(nil), v...)
		} else {
			b, e = externalRead(in.ImagePaths[k], MaxImage)
			if e != nil {
				return preview, e
			}
		}
		total += int64(len(b))
		plan.size += int64(len(b))
		if total > MaxBatch {
			return preview, fail("BATCH_TOO_LARGE", "Image upload exceeds 1 GiB")
		}
		if pending+plan.size > 2*MaxBatch {
			return preview, fail("LIBRARY_BUSY", "Pending upload storage exceeds 2 GiB")
		}
		im, ie := inspectImage(b)
		if ie != nil || !extensionMatches(k, im.mime) {
			catalog[k] = &stagedImage{relative: k}
			continue
		}
		rel := fmt.Sprintf("%s/image-%04d", stage, n)
		if e = s.writeExclusive(rel, b); e != nil {
			return preview, e
		}
		catalog[k] = &stagedImage{k, rel, im}
	}
	for n, raw := range rawMaps {
		id := ids[n]
		label := ""
		json.Unmarshal(raw["label"], &label)
		row := BatchRow{Index: n, ID: id, Label: label, Status: "error", IssueCodes: []string{}}
		issue := func(code, severity string) {
			row.IssueCodes = append(row.IssueCodes, code)
			rn := n
			preview.Issues = append(preview.Issues, Issue{Code: code, Severity: severity, RecordIndex: &rn, ID: id, SourceFileName: row.SourceFileName, SourceRelativePath: row.SourceRelativePath})
		}
		bad := false
		switch {
		case raw == nil:
			issue("INVALID_RECORD", "error")
			bad = true
		case id == 0:
			issue("INVALID_ID", "error")
			bad = true
		case idCounts[id] > 1:
			issue("DUPLICATE_ID", "error")
			bad = true
		case nameErrors[n] != "":
			issue(nameErrors[n], "error")
			bad = true
		case names[n] != "" && nameCounts[names[n]] > 1:
			issue("DUPLICATE_IMAGE_NAME", "error")
			bad = true
		}
		if bad {
			preview.Items = append(preview.Items, row)
			continue
		}
		name := names[n]
		if name != "" && leadingID(path.Base(name)) != 0 && leadingID(path.Base(name)) != id {
			issue("ID_FILENAME_MISMATCH", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		candidates := []string{}
		method := ""
		if name != "" {
			if strings.Contains(name, "/") {
				if keys[name] {
					candidates = append(candidates, name)
				}
			} else {
				for k := range keys {
					if path.Base(k) == name {
						candidates = append(candidates, k)
					}
				}
			}
			if len(candidates) > 0 {
				method = "exact"
			}
		}
		if len(candidates) == 0 && name != "" && !strings.Contains(name, "/") && leadingID(name) == id {
			for k := range keys {
				m := leadingPattern.FindStringSubmatch(path.Base(k))
				if m != nil && leadingID(path.Base(k)) == id && m[2] == name {
					candidates = append(candidates, k)
				}
			}
			if len(candidates) > 0 {
				method = "duplicate-leading-id-prefix"
			}
		}
		if len(candidates) == 0 && name == "" {
			for k := range keys {
				if leadingID(path.Base(k)) == id {
					candidates = append(candidates, k)
				}
			}
			method = "leading-id"
		}
		if len(candidates) == 0 {
			row.Status = "unmatched"
			issue("IMAGE_NOT_FOUND", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		if len(candidates) != 1 {
			issue("AMBIGUOUS_IMAGE", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		rel := candidates[0]
		im := catalog[rel]
		row.SourceRelativePath = rel
		row.SourceFileName = path.Base(rel)
		row.MatchMethod = method
		if leadingID(row.SourceFileName) != 0 && leadingID(row.SourceFileName) != id {
			issue("ID_FILENAME_MISMATCH", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		if used[rel] {
			issue("IMAGE_ALREADY_MATCHED", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		used[rel] = true
		if im.stage == "" {
			issue("INVALID_IMAGE", "error")
			preview.Items = append(preview.Items, row)
			continue
		}
		preview.Counts.Matched++
		if claimed, ok := raw["sha256"]; ok {
			var sha string
			if json.Unmarshal(claimed, &sha) != nil || !hashPattern.MatchString(sha) || sha != im.info.sha {
				issue("SOURCE_HASH_MISMATCH", "error")
				preview.Items = append(preview.Items, row)
				continue
			}
		}
		en, enField, enInvalid := recordPrompt(raw, "prompt_en", "prompt", "prompts.en")
		zh, _, zhInvalid := recordPrompt(raw, "prompt_cn", "prompt_zh", "prompts.zh")
		var provenance map[string]any
		if derived, ok := in.DerivedChinesePrompts[strconv.Itoa(id)]; ok {
			zh = derived
			provenance = map[string]any{"kind": "derived-translation", "origin": "assistant-translation", "sourceLanguage": "en", "targetLanguage": "zh", "sourcePromptField": enField, "sourcePromptSha256": digest([]byte(en)), "translatedPromptSha256": digest([]byte(zh)), "sourceId": id, "recordIndex": n, "manifestSha256": preview.ManifestSHA256}
		}
		if en == "" {
			code := "MISSING_PROMPT_EN"
			if enInvalid {
				code = "INVALID_PROMPT_EN"
			}
			issue(code, "error")
			bad = true
		}
		if zh == "" {
			code := "MISSING_PROMPT_ZH"
			if zhInvalid {
				code = "INVALID_PROMPT_ZH"
			}
			issue(code, "error")
			bad = true
		}
		typ, typeOrigin := "", "source"
		json.Unmarshal(raw["type"], &typ)
		if typ != "photo" && typ != "art" {
			json.Unmarshal(raw["category"], &typ)
		}
		if typ != "photo" && typ != "art" {
			typ = in.Type
			typeOrigin = "selected-default"
			issue("SELECTED_DEFAULT_TYPE", "info")
		}
		md := Metadata{id, label, typ, Prompts{en, zh}}
		if validateMetadata(md) != nil && en != "" && zh != "" {
			issue("INVALID_LABEL", "error")
			bad = true
		}
		if !bad {
			row.Status = "importable"
			plan.records = append(plan.records, batchRecord{id, n, md, append([]byte(nil), rows[n]...), im, method, typeOrigin, provenance})
			preview.Counts.Importable++
		}
		preview.Items = append(preview.Items, row)
	}
	for _, k := range sortedKeys(keys) {
		if !used[k] {
			preview.Unpaired = append(preview.Unpaired, Issue{Code: "NO_UNIQUE_MANIFEST_RECORD", Severity: "error", SourceFileName: path.Base(k), SourceRelativePath: k})
		}
	}
	for _, r := range preview.Items {
		if r.Status == "error" {
			preview.Counts.Errors++
		}
		if r.Status == "unmatched" {
			preview.Counts.Unmatched++
		}
	}
	preview.Counts.Unpaired = len(preview.Unpaired)
	plan.preview = preview
	s.classify(idx, plan)
	preview = plan.preview
	if e := s.contextErr(); e != nil {
		return preview, e
	}
	s.previews[previewID] = plan
	success = true
	return preview, nil
}
func (s *Store) classify(idx Snapshot, p *batchPlan) {
	hashes := map[string]int{}
	ids := map[int]bool{}
	reserved := map[int]bool{}
	maxID := 0
	for _, i := range idx.Items {
		ids[i.ID] = true
		reserved[i.ID] = true
		if i.ID > maxID {
			maxID = i.ID
		}
		if current, ok := hashes[i.SHA256]; !ok || i.ID < current {
			hashes[i.SHA256] = i.ID
		}
	}
	ordered := append([]batchRecord(nil), p.records...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].sourceID < ordered[j].sourceID })
	for _, r := range ordered {
		reserved[r.sourceID] = true
		if r.sourceID > maxID {
			maxID = r.sourceID
		}
	}
	p.preview.Counts.Imported = 0
	p.preview.Counts.Skipped = 0
	p.preview.Counts.Conflicts = 0
	for _, rec := range ordered {
		row := &p.preview.Items[rec.index]
		if existing, ok := hashes[rec.image.info.sha]; ok {
			row.Status = "skip"
			row.TargetID = existing
			p.preview.Counts.Skipped++
			continue
		}
		id := rec.sourceID
		if ids[id] {
			if p.policy == "conflict" {
				row.Status = "conflict"
				p.preview.Counts.Conflicts++
				continue
			}
			maxID++
			id = maxID
			for reserved[id] && id <= 999999 {
				id++
				maxID = id
			}
			if !validID(id) {
				id = 1
				for reserved[id] && id <= 999999 {
					id++
				}
			}
			if !validID(id) {
				row.Status = "conflict"
				p.preview.Counts.Conflicts++
				continue
			}
		}
		row.TargetID = id
		row.Status = "import"
		ids[id] = true
		reserved[id] = true
		hashes[rec.image.info.sha] = id
		p.preview.Counts.Imported++
	}
	p.preview.Counts.Importable = p.preview.Counts.Imported
}
func (s *Store) CommitBatch(in CommitBatchInput) (BatchResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.operationContext = in.Context
	defer func() { s.operationContext = nil }()
	if e := s.contextErr(); e != nil {
		return BatchResult{}, e
	}
	if !in.Confirmed {
		return BatchResult{}, fail("CONFIRMATION_REQUIRED", "Batch commit requires confirmation")
	}
	if !tokenPattern.MatchString(in.PreviewID) {
		return BatchResult{}, fail("INVALID_BATCH_SELECTION", "Invalid preview ID")
	}
	p, ok := s.previews[in.PreviewID]
	if !ok {
		return BatchResult{}, fail("INVALID_BATCH_SELECTION", "Preview no longer exists")
	}
	if time.Now().After(p.expires) {
		s.removeOwnedTree(p.stage)
		delete(s.previews, in.PreviewID)
		return BatchResult{}, fail("BATCH_EXPIRED", "Preview expired")
	}
	idx, before, e := s.load(false)
	if e != nil {
		return BatchResult{}, e
	}
	if e = compare(idx, in.ExpectedVersion, nil, 0); e != nil {
		return BatchResult{}, e
	}
	if in.ExpectedVersion != p.preview.Revision {
		return BatchResult{}, fail("CONFLICT", "Library changed after preview")
	}
	s.classify(idx, p)
	result := BatchResult{Revision: idx.Revision, Imported: p.preview.Counts.Imported, Skipped: p.preview.Counts.Skipped, Counts: p.preview.Counts, Items: append([]BatchRow(nil), p.preview.Items...)}
	if p.preview.Counts.Conflicts > 0 {
		return BatchResult{}, fail("CONFLICT", "Batch has ID conflicts")
	}
	if result.Imported == 0 && result.Skipped == 0 {
		return BatchResult{}, fail("INVALID_DATA", "Batch has no importable or duplicate records")
	}
	b, e := s.read(p.stage+"/manifest.json", MaxIndex)
	if e != nil || digest(b) != p.preview.ManifestSHA256 || !bytes.Equal(b, p.manifest) {
		return BatchResult{}, fail("SOURCE_CHANGED", "Staged manifest changed")
	}
	for _, r := range p.records {
		b, e := s.read(r.image.stage, MaxImage)
		if e != nil || digest(b) != r.image.info.sha || int64(len(b)) != r.image.info.size {
			return BatchResult{}, fail("SOURCE_CHANGED", "Staged image changed")
		}
	}
	if result.Imported == 0 {
		if e = s.removeOwnedTree(p.stage); e != nil {
			return BatchResult{}, e
		}
		delete(s.previews, in.PreviewID)
		return result, nil
	}
	if len(idx.Items)+result.Imported > MaxItems {
		return BatchResult{}, fail("LIBRARY_TOO_LARGE", "Library limit is 10000 portraits")
	}
	id := token()
	archive := meta + "/imports/" + id
	if e = s.mkdir(archive); e != nil {
		return BatchResult{}, e
	}
	after := cloneSnapshot(idx)
	sources := map[string]string{}
	for _, r := range p.records {
		row := p.preview.Items[r.index]
		if row.Status != "import" {
			continue
		}
		imageName := idName(row.TargetID, id, r.image.info.ext)
		source := map[string]any{"archiveRel": archive, "manifestSha256": p.preview.ManifestSHA256, "sourceHash": r.image.info.sha, "sourceId": r.sourceID, "recordIndex": r.index, "sourceFileName": path.Base(r.image.relative), "sourceRelativePath": r.image.relative, "typeOrigin": r.typeOrigin, "matchMethod": r.match}
		if r.provenance != nil {
			source["translationProvenance"] = r.provenance
			source["derivedChinesePrompt"] = r.metadata.Prompts.ZH
		}
		sourceRaw, _ := json.Marshal(source)
		item := Item{ID: row.TargetID, Label: r.metadata.Label, Type: r.metadata.Type, Prompts: r.metadata.Prompts, Image: imageName, ImageRel: "assets/images/" + imageName, Revision: 1, SHA256: r.image.info.sha, Size: r.image.info.size, MIME: r.image.info.mime, SourceMetadata: r.raw, SourceImport: sourceRaw}
		after.Items = append(after.Items, item)
		sources[item.ImageRel] = r.image.stage
	}
	after.Revision++
	after.UpdatedAt = utcNow()
	mapping, _ := encode(p.preview.Items)
	source, _ := encode(map[string]any{"schemaVersion": 1, "batchId": id, "manifestName": p.manifestName, "manifestSha256": p.preview.ManifestSHA256, "collisionPolicy": p.policy, "issues": p.preview.Issues, "unpaired": p.preview.Unpaired, "counts": p.preview.Counts})
	if e = s.transactSources(id, before, after, []installBytes{{archive + "/manifest.json", p.manifest}, {archive + "/mapping.json", mapping}, {archive + "/source.json", source}}, sources, nil); e != nil {
		return BatchResult{}, e
	}
	result.Revision = after.Revision
	result.ArchiveRel = archive
	if e = s.removeOwnedTree(p.stage); e != nil {
		return result, e
	}
	delete(s.previews, in.PreviewID)
	return result, nil
}
func (s *Store) CancelBatch(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !tokenPattern.MatchString(id) {
		return fail("INVALID_BATCH_SELECTION", "Invalid preview ID")
	}
	p, ok := s.previews[id]
	if !ok {
		return nil
	}
	if e := s.removeOwnedTree(p.stage); e != nil {
		return e
	}
	delete(s.previews, id)
	return nil
}
func validateProvenance(raw, source map[string]json.RawMessage) error {
	var p map[string]json.RawMessage
	if json.Unmarshal(source["translationProvenance"], &p) != nil || len(p) != 10 {
		return fail("INVALID_DATA", "Invalid translation provenance")
	}
	text := func(m map[string]json.RawMessage, k string) string { var s string; json.Unmarshal(m[k], &s); return s }
	en, field, _ := recordPrompt(raw, "prompt_en", "prompt", "prompts.en")
	zh, _, invalid := recordPrompt(raw, "prompt_cn", "prompt_zh", "prompts.zh")
	derived := text(source, "derivedChinesePrompt")
	var pi, si int
	json.Unmarshal(p["recordIndex"], &pi)
	json.Unmarshal(source["recordIndex"], &si)
	if en == "" || zh != "" || invalid || strings.TrimSpace(derived) == "" || textLength(derived) > 65536 || strings.ContainsRune(derived, 0) || text(p, "kind") != "derived-translation" || text(p, "origin") != "assistant-translation" || text(p, "sourceLanguage") != "en" || text(p, "targetLanguage") != "zh" || text(p, "sourcePromptField") != field || text(p, "sourcePromptSha256") != digest([]byte(en)) || text(p, "translatedPromptSha256") != digest([]byte(derived)) || text(p, "manifestSha256") != text(source, "manifestSha256") || recordID(p["sourceId"]) != recordID(source["sourceId"]) || recordID(source["sourceId"]) != recordID(raw["id"]) || pi != si {
		return fail("INVALID_DATA", "Derived translation does not match source")
	}
	return nil
}
func DiscoverManifests(manifests map[string][]byte) (map[string]int, error) {
	if len(manifests) > 32 {
		return nil, fail("TOO_MANY_MANIFESTS", "At most 32 JSON manifests")
	}
	out := map[string]int{}
	var total int64
	for name, b := range manifests {
		if !safeRelative(name) || len(strings.Split(name, "/")) > 4 {
			return nil, fail("UNSAFE_PATH", "Unsafe manifest path")
		}
		total += int64(len(b))
		if total > 64<<20 {
			return nil, fail("MANIFEST_TOTAL_TOO_LARGE", "JSON total exceeds 64 MiB")
		}
		rows, e := extractRecords(b)
		if e == nil {
			out[name] = len(rows)
		}
	}
	if len(out) == 0 {
		return nil, fail("NO_MANIFEST", "No supported JSON manifest")
	}
	return out, nil
}
