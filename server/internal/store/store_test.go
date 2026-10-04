package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testRoot(t *testing.T) string {
	t.Helper()
	r, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func testStore(t *testing.T) (*Store, string) {
	t.Helper()
	r := testRoot(t)
	s, e := Open(r)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s, r
}
func pngBytes(t *testing.T, n byte) []byte {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, 3, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 3; x++ {
			im.Set(x, y, color.NRGBA{n, byte(x * 39), byte(y * 59), 255})
		}
	}
	var b bytes.Buffer
	if e := png.Encode(&b, im); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func md(id int) Metadata {
	return Metadata{id, "完整名称", "photo", Prompts{strings.Repeat("English prompt\n", 80), strings.Repeat("完整中文提示词。\n", 80)}}
}
func create(t *testing.T, s *Store, id int, n byte) MutationResult {
	t.Helper()
	idx, e := s.List()
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.Create(CreateInput{Metadata: md(id), ExpectedVersion: idx.Revision, Image: pngBytes(t, n)})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || ErrorCode(err) != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func manifestRecord(id int, name string) map[string]any {
	return map[string]any{"id": id, "image": name, "label": "原始名", "prompt_en": "Complete original English\nAll details", "prompt_cn": "完整中文\n所有细节", "category": "原始分类", "custom": map[string]any{"unknown": [2]any{"preserve", 42}}}
}
func batchInput(t *testing.T, rows []map[string]any, images map[string][]byte) BatchInput {
	t.Helper()
	b, e := json.MarshalIndent(map[string]any{"images": rows, "count_requested": len(rows), "unknown_root": "完整保留"}, "", "   ")
	if e != nil {
		t.Fatal(e)
	}
	return BatchInput{Manifest: append(b, '\n'), ManifestName: "original.json", Images: images, Type: "photo", CollisionPolicy: "allocate-new"}
}
func previewCommit(t *testing.T, s *Store, in BatchInput) (BatchPreview, BatchResult) {
	t.Helper()
	p, e := s.PreviewBatch(in)
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.CommitBatch(CommitBatchInput{PreviewID: p.PreviewID, ExpectedVersion: p.Revision, Confirmed: true})
	if e != nil {
		t.Fatal(e)
	}
	return p, r
}

func TestCRUDCASFullPromptsAndRecoveryArchive(t *testing.T) {
	s, root := testStore(t)
	created := create(t, s, 7, 10)
	old := *created.Item
	originalIndex, _ := os.ReadFile(filepath.Join(root, indexRel))
	_, e := s.Update(UpdateInput{Metadata: md(7), ExpectedVersion: 1, ExpectedRevision: 1})
	requireCode(t, e, "CONFLICT")
	after, _ := os.ReadFile(filepath.Join(root, indexRel))
	if !bytes.Equal(originalIndex, after) {
		t.Fatal("stale update changed index")
	}
	updated := md(7)
	updated.Prompts.ZH = strings.Repeat("更新后的完整中文。", 120)
	u, e := s.Update(UpdateInput{Metadata: updated, ExpectedVersion: 2, ExpectedRevision: 1})
	if e != nil || u.Item.Prompts.ZH != updated.Prompts.ZH || u.Item.ImageRel != old.ImageRel {
		t.Fatalf("update: %+v %v", u, e)
	}
	_, e = s.Delete(DeleteInput{ID: 7, ExpectedVersion: 3, ExpectedRevision: 2})
	requireCode(t, e, "CONFIRMATION_REQUIRED")
	d, e := s.Delete(DeleteInput{ID: 7, ExpectedVersion: 3, ExpectedRevision: 2, Confirmed: true})
	if e != nil {
		t.Fatal(e)
	}
	if d.Revision != 4 || d.RecoveryID == "" {
		t.Fatal(d)
	}
	archived, _ := os.ReadFile(filepath.Join(root, meta, "recovery", d.RecoveryID, old.Image))
	if !bytes.Equal(archived, pngBytes(t, 10)) {
		t.Fatal("exact image not archived")
	}
	raw, _ := os.ReadFile(filepath.Join(root, meta, "recovery", d.RecoveryID, "item.json"))
	var saved Item
	if json.Unmarshal(raw, &saved) != nil || saved.Prompts.ZH != updated.Prompts.ZH || saved.Prompts.EN != old.Prompts.EN {
		t.Fatal("full prompts not archived")
	}
	if _, e = os.Lstat(filepath.Join(root, old.ImageRel)); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("deleted image should only remain in recovery")
	}
	s.Close()
	s2, e := Open(root)
	if e != nil {
		t.Fatal(e)
	}
	defer s2.Close()
	idx, e := s2.List()
	if e != nil || len(idx.Items) != 0 || idx.Revision != 4 {
		t.Fatalf("restart %+v %v", idx, e)
	}
}
func TestImageReplacementRetainsSourceFieldsAndOldBytes(t *testing.T) {
	s, root := testStore(t)
	in := batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{"images/one.png": pngBytes(t, 1)})
	_, r := previewCommit(t, s, in)
	old, _, _ := s.Get(1)
	u, e := s.Update(UpdateInput{Metadata: md(1), ExpectedVersion: r.Revision, ExpectedRevision: 1, Image: pngBytes(t, 2)})
	if e != nil {
		t.Fatal(e)
	}
	if !equalJSON(old.SourceMetadata, u.Item.SourceMetadata) || !equalJSON(old.SourceImport, u.Item.SourceImport) {
		t.Fatal("edit destroyed source fields")
	}
	archived, _ := os.ReadFile(filepath.Join(root, meta, "recovery", u.RecoveryID, old.Image))
	if !bytes.Equal(archived, pngBytes(t, 1)) {
		t.Fatal("old image lost")
	}
	img, e := s.ReadImage(1)
	if e != nil || !bytes.Equal(img.Bytes, pngBytes(t, 2)) {
		t.Fatal(e)
	}
}
func TestBatchWrapperRawFieldsDerivedTranslationCollisionAndIdempotence(t *testing.T) {
	s, root := testStore(t)
	create(t, s, 1, 1)
	row := manifestRecord(1, "001-new.png")
	delete(row, "prompt_cn")
	in := batchInput(t, []map[string]any{row}, map[string][]byte{"generated/001-new.png": pngBytes(t, 2)})
	in.DerivedChinesePrompts = map[string]string{"1": "这是完整衍生中文译文，保留所有细节。\n第二行"}
	p, r := previewCommit(t, s, in)
	if p.Counts.Importable != 1 || r.Imported != 1 || r.Items[0].TargetID != 2 {
		t.Fatalf("preview/result %+v %+v", p, r)
	}
	item, _, _ := s.Get(2)
	raw, _ := json.Marshal(row)
	if !equalJSON(raw, item.SourceMetadata) || item.Prompts.EN != row["prompt_en"] || item.Prompts.ZH != in.DerivedChinesePrompts["1"] {
		t.Fatal("original source or derived prompts changed")
	}
	var source map[string]json.RawMessage
	json.Unmarshal(item.SourceImport, &source)
	if recordID(source["sourceId"]) != 1 || validateProvenance(mapFromRaw(item.SourceMetadata), source) != nil {
		t.Fatal("invalid provenance")
	}
	manifest, _ := os.ReadFile(filepath.Join(root, r.ArchiveRel, "manifest.json"))
	if !bytes.Equal(manifest, in.Manifest) {
		t.Fatal("original wrapper JSON bytes changed")
	}
	before, _ := os.ReadFile(filepath.Join(root, indexRel))
	p2, r2 := previewCommit(t, s, in)
	after, _ := os.ReadFile(filepath.Join(root, indexRel))
	if p2.Counts.Importable != 0 || r2.Imported != 0 || r2.Skipped != 1 || r2.Revision != r.Revision || !bytes.Equal(before, after) {
		t.Fatalf("repeat not idempotent %+v %+v", p2, r2)
	}
	s.Close()
	s2, e := Open(root)
	if e != nil {
		t.Fatal(e)
	}
	defer s2.Close()
	item2, _, _ := s2.Get(2)
	if !equalJSON(item.SourceImport, item2.SourceImport) {
		t.Fatal("restart changed provenance")
	}
}
func mapFromRaw(b []byte) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	json.Unmarshal(b, &m)
	return m
}
func TestBatchAllocatesDeterministicallyAndSkipsDuplicatesInBatch(t *testing.T) {
	s, _ := testStore(t)
	create(t, s, 1, 1)
	rows := []map[string]any{manifestRecord(2, "two.png"), manifestRecord(1, "one.png"), manifestRecord(3, "three.png")}
	in := batchInput(t, rows, map[string][]byte{"two.png": pngBytes(t, 3), "one.png": pngBytes(t, 2), "three.png": pngBytes(t, 2)})
	p, r := previewCommit(t, s, in)
	if r.Imported != 2 || r.Skipped != 1 || p.Items[0].TargetID != 2 || p.Items[1].TargetID != 4 || p.Items[2].TargetID != 4 {
		t.Fatalf("mapping %+v", p.Items)
	}
}
func TestBatchCancelExpiryAndCASLeaveGalleryUnchanged(t *testing.T) {
	s, root := testStore(t)
	in := batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{"one.png": pngBytes(t, 1)})
	before, _ := os.ReadFile(filepath.Join(root, indexRel))
	p, e := s.PreviewBatch(in)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.CancelBatch(p.PreviewID); e != nil {
		t.Fatal(e)
	}
	after, _ := os.ReadFile(filepath.Join(root, indexRel))
	if !bytes.Equal(before, after) {
		t.Fatal("cancel changed gallery")
	}
	if _, e = os.Lstat(filepath.Join(root, meta, "go-staging", p.PreviewID)); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("cancel leaked staging")
	}
	p, e = s.PreviewBatch(in)
	if e != nil {
		t.Fatal(e)
	}
	s.previews[p.PreviewID].expires = time.Now().Add(-time.Second)
	_, e = s.CommitBatch(CommitBatchInput{PreviewID: p.PreviewID, ExpectedVersion: 1, Confirmed: true})
	requireCode(t, e, "BATCH_EXPIRED")
	p, e = s.PreviewBatch(in)
	if e != nil {
		t.Fatal(e)
	}
	create(t, s, 4, 4)
	_, e = s.CommitBatch(CommitBatchInput{PreviewID: p.PreviewID, ExpectedVersion: p.Revision, Confirmed: true})
	requireCode(t, e, "CONFLICT")
	idx, _ := s.List()
	if len(idx.Items) != 1 || idx.Items[0].ID != 4 {
		t.Fatal("CAS modified library")
	}
}
func TestBatchStrictPairingAndLanguageErrors(t *testing.T) {
	cases := []struct {
		name   string
		rows   []map[string]any
		images map[string][]byte
		code   string
	}{
		{"ambiguous basename", []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{"a/one.png": pngBytes(t, 1), "b/one.png": pngBytes(t, 2)}, "AMBIGUOUS_IMAGE"},
		{"explicit filename never fuzzy", []map[string]any{manifestRecord(1, "001-wanted.png")}, map[string][]byte{"001-other.png": pngBytes(t, 1)}, "IMAGE_NOT_FOUND"},
		{"duplicate IDs", []map[string]any{manifestRecord(1, "one.png"), manifestRecord(1, "two.png")}, map[string][]byte{"one.png": pngBytes(t, 1), "two.png": pngBytes(t, 2)}, "DUPLICATE_ID"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := testStore(t)
			p, e := s.PreviewBatch(batchInput(t, c.rows, c.images))
			if e != nil {
				t.Fatal(e)
			}
			if p.Counts.Importable != 0 || p.Items[0].IssueCodes[0] != c.code {
				t.Fatalf("%+v", p)
			}
		})
	}
	s, _ := testStore(t)
	row := manifestRecord(1, "001-one.png")
	delete(row, "prompt_cn")
	p, e := s.PreviewBatch(batchInput(t, []map[string]any{row}, map[string][]byte{"images/001-one.png": pngBytes(t, 1)}))
	if e != nil {
		t.Fatal(e)
	}
	if p.Counts.Matched != 1 || p.Counts.Importable != 0 || p.Items[0].IssueCodes[0] != "MISSING_PROMPT_ZH" {
		t.Fatal(p)
	}
	row = manifestRecord(1, "images/001-one.png")
	p, e = s.PreviewBatch(batchInput(t, []map[string]any{row}, map[string][]byte{"images/001-one.png": pngBytes(t, 1)}))
	if e != nil || p.Counts.Importable != 1 {
		t.Fatalf("explicit relative pairing %+v %v", p, e)
	}
	row = manifestRecord(1, "001-one.png")
	p, e = s.PreviewBatch(batchInput(t, []map[string]any{row}, map[string][]byte{"images/001-001-one.png": pngBytes(t, 1)}))
	if e != nil || p.Items[0].MatchMethod != "duplicate-leading-id-prefix" {
		t.Fatalf("prefix %+v %v", p, e)
	}
}
func TestRejectsTraversalSymlinksInvalidImagesAndTranslations(t *testing.T) {
	s, root := testStore(t)
	for _, name := range []string{"../escape.png", "/escape.png", "images/../../escape.png", "a/b/c/d/e.png", "a\\b.png"} {
		_, e := s.PreviewBatch(batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{name: pngBytes(t, 1)}))
		requireCode(t, e, "UNSAFE_PATH")
	}
	outside := filepath.Join(testRoot(t), "outside.png")
	os.WriteFile(outside, pngBytes(t, 1), 0600)
	link := filepath.Join(root, "link.png")
	os.Symlink(outside, link)
	in := batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, nil)
	in.ImagePaths = map[string]string{"one.png": link}
	_, e := s.PreviewBatch(in)
	requireCode(t, e, "UNSAFE_PATH")
	_, e = s.Create(CreateInput{Metadata: md(1), ExpectedVersion: 1, Image: pngBytes(t, 1)[:40]})
	requireCode(t, e, "INVALID_IMAGE")
	in = batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{"one.png": pngBytes(t, 1)})
	in.DerivedChinesePrompts = map[string]string{"1": "Cannot replace existing source Chinese"}
	_, e = s.PreviewBatch(in)
	requireCode(t, e, "INVALID_TRANSLATION")
	var jpg bytes.Buffer
	jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil)
	_, e = s.Create(CreateInput{Metadata: md(2), ExpectedVersion: 1, Image: jpg.Bytes()})
	if e != nil {
		t.Fatal(e)
	}
}
func TestCrashRecoveryBeforeAndAfterAtomicIndex(t *testing.T) {
	for _, stage := range []string{"after-journal", "after-install", "after-index", "before-cleanup"} {
		t.Run(stage, func(t *testing.T) {
			s, root := testStore(t)
			crash := errors.New("simulated process death")
			s.fault = func(p string) error {
				if p == stage {
					return crash
				}
				return nil
			}
			_, e := s.Create(CreateInput{Metadata: md(1), ExpectedVersion: 1, Image: pngBytes(t, 1)})
			if !errors.Is(e, crash) {
				t.Fatal(e)
			}
			s.Close()
			s2, e := Open(root)
			if e != nil {
				t.Fatal(e)
			}
			defer s2.Close()
			idx, e := s2.List()
			if e != nil {
				t.Fatal(e)
			}
			committed := stage == "after-index" || stage == "before-cleanup"
			if committed && len(idx.Items) != 1 || !committed && len(idx.Items) != 0 {
				t.Fatalf("wrong atomic outcome %+v", idx)
			}
			if committed {
				img, e := s2.ReadImage(1)
				if e != nil || !bytes.Equal(img.Bytes, pngBytes(t, 1)) {
					t.Fatal("committed image lost", e)
				}
			}
			txs, _ := os.ReadDir(filepath.Join(root, meta, "go-transactions"))
			if len(txs) != 0 {
				t.Fatal("active journals not recovered")
			}
		})
	}
}
func TestCancelledDuringStagingRollsBackBeforeIndex(t *testing.T) {
	s, root := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	s.fault = func(p string) error {
		if p == "after-install" {
			cancel()
		}
		return nil
	}
	before, _ := os.ReadFile(filepath.Join(root, indexRel))
	_, e := s.Create(CreateInput{Context: ctx, Metadata: md(1), ExpectedVersion: 1, Image: pngBytes(t, 1)})
	requireCode(t, e, "ABORTED")
	after, _ := os.ReadFile(filepath.Join(root, indexRel))
	if !bytes.Equal(before, after) {
		t.Fatal("cancelled mutation committed")
	}
	s.fault = nil
	idx, e := s.List()
	if e != nil || len(idx.Items) != 0 {
		t.Fatal(e)
	}
}
func TestExternalChangesAndLockReplacementNeverOverwrite(t *testing.T) {
	t.Run("process lock", func(t *testing.T) {
		s, root := testStore(t)
		_, e := Open(root)
		requireCode(t, e, "LIBRARY_BUSY")
		_ = s
	})
	t.Run("lock replacement", func(t *testing.T) {
		s, root := testStore(t)
		lock := filepath.Join(root, meta, "go-store.lock")
		os.Rename(lock, lock+"-old")
		os.WriteFile(lock, []byte{}, 0600)
		_, e := s.List()
		requireCode(t, e, "LIBRARY_BUSY")
	})
	t.Run("index changed", func(t *testing.T) {
		s, root := testStore(t)
		p := filepath.Join(root, indexRel)
		b, _ := os.ReadFile(p)
		changed := append(b, ' ')
		os.WriteFile(p, changed, 0600)
		_, e := s.Create(CreateInput{Metadata: md(1), ExpectedVersion: 1, Image: pngBytes(t, 1)})
		requireCode(t, e, "CONFLICT")
		actual, _ := os.ReadFile(p)
		if !bytes.Equal(actual, changed) {
			t.Fatal("external index overwritten")
		}
	})
	t.Run("image symlink", func(t *testing.T) {
		s, root := testStore(t)
		r := create(t, s, 1, 1)
		outside := filepath.Join(testRoot(t), "outside.png")
		b := pngBytes(t, 9)
		os.WriteFile(outside, b, 0600)
		name := filepath.Join(root, r.Item.ImageRel)
		os.Rename(name, name+"-old")
		os.Symlink(outside, name)
		_, e := s.ReadImage(1)
		requireCode(t, e, "UNSAFE_PATH")
		actual, _ := os.ReadFile(outside)
		if !bytes.Equal(actual, b) {
			t.Fatal("outside file changed")
		}
	})
}
func TestRecoveryConflictPreservesExternalIndexAndAllImages(t *testing.T) {
	s, root := testStore(t)
	s.fault = func(p string) error {
		if p == "after-install" {
			return errors.New("crash")
		}
		return nil
	}
	_, e := s.Create(CreateInput{Metadata: md(1), ExpectedVersion: 1, Image: pngBytes(t, 1)})
	if e == nil {
		t.Fatal("fault did not trigger")
	}
	s.Close()
	idx := Snapshot{SchemaVersion: 1, Revision: 9, Items: []Item{}, UpdatedAt: utcNow()}
	external, _ := encode(idx)
	os.WriteFile(filepath.Join(root, indexRel), external, 0600)
	_, e = Open(root)
	requireCode(t, e, "RECOVERY_CONFLICT")
	actual, _ := os.ReadFile(filepath.Join(root, indexRel))
	if !bytes.Equal(actual, external) {
		t.Fatal("recovery overwrote external index")
	}
	images, _ := os.ReadDir(filepath.Join(root, "assets", "images"))
	if len(images) != 1 {
		t.Fatal("uncommitted image not retained")
	}
	journals, _ := os.ReadDir(filepath.Join(root, meta, "go-transactions"))
	if len(journals) != 1 {
		t.Fatal("conflicting journal not retained")
	}
}

func TestFiftyCollidingSourceIDsBecome51Through100AndRepeatSkipsAll(t *testing.T) {
	s, root := testStore(t)
	// Build a valid copied legacy schema fixture at revision 2, without changing
	// any original image or metadata bytes when the new batch commits.
	legacy := Snapshot{SchemaVersion: 1, Revision: 2, UpdatedAt: utcNow(), Items: []Item{}}
	for id := 1; id <= 50; id++ {
		b := pngBytes(t, byte(id))
		im, e := inspectImage(b)
		if e != nil {
			t.Fatal(e)
		}
		name := idName(id, "legacy", im.ext)
		if e = s.writeExclusive("assets/images/"+name, b); e != nil {
			t.Fatal(e)
		}
		m := md(id)
		legacy.Items = append(legacy.Items, Item{ID: id, Label: m.Label, Type: m.Type, Prompts: m.Prompts, Image: name, ImageRel: "assets/images/" + name, Revision: 1, SHA256: im.sha, Size: im.size, MIME: im.mime})
	}
	old, _ := s.read(indexRel, MaxIndex)
	legacyBytes, _ := checkIndexSize(legacy)
	if e := s.atomic(indexRel, legacyBytes, digest(old)); e != nil {
		t.Fatal(e)
	}
	s.indexHash = digest(legacyBytes)
	rows := []map[string]any{}
	images := map[string][]byte{}
	translations := map[string]string{}
	for id := 1; id <= 50; id++ {
		name := idName(id, "new", "png")
		row := manifestRecord(id, name)
		delete(row, "prompt_cn")
		rows = append(rows, row)
		images["generated/"+name] = pngBytes(t, byte(id+100))
		translations[fmt.Sprint(id)] = "完整中文衍生翻译：所有场景、人物、镜头、光线和约束逐一保留。"
	}
	in := batchInput(t, rows, images)
	in.DerivedChinesePrompts = translations
	p, r := previewCommit(t, s, in)
	if r.Imported != 50 || p.Counts.Importable != 50 || r.Revision != 3 {
		t.Fatalf("%+v", r)
	}
	idx, e := s.List()
	if e != nil || len(idx.Items) != 100 {
		t.Fatalf("library %+v %v", idx, e)
	}
	for n, row := range r.Items {
		if row.ID != n+1 || row.TargetID != n+51 {
			t.Fatalf("source mapping %+v", row)
		}
	}
	for n := 0; n < 50; n++ {
		a, _ := json.Marshal(legacy.Items[n])
		b, _ := json.Marshal(idx.Items[n])
		if !bytes.Equal(a, b) {
			t.Fatal("legacy entry changed")
		}
		actual, e := s.read(legacy.Items[n].ImageRel, MaxImage)
		if e != nil || digest(actual) != legacy.Items[n].SHA256 {
			t.Fatal("legacy image changed")
		}
	}
	before, _ := os.ReadFile(filepath.Join(root, indexRel))
	p2, r2 := previewCommit(t, s, in)
	after, _ := os.ReadFile(filepath.Join(root, indexRel))
	if r2.Imported != 0 || r2.Skipped != 50 || p2.Counts.Importable != 0 || !bytes.Equal(before, after) {
		t.Fatalf("repeated batch %+v", r2)
	}
}
func TestRootAndManagedDirectoryReplacementStopsAccess(t *testing.T) {
	t.Run("root replaced", func(t *testing.T) {
		s, root := testStore(t)
		old := root + "-original"
		if e := os.Rename(root, old); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { os.Remove(root); os.Rename(old, root) })
		if e := os.Mkdir(root, 0700); e != nil {
			t.Fatal(e)
		}
		_, e := s.List()
		requireCode(t, e, "UNSAFE_PATH")
	})
	t.Run("managed directory replaced", func(t *testing.T) {
		s, root := testStore(t)
		original := filepath.Join(root, meta)
		if e := os.Rename(original, original+"-original"); e != nil {
			t.Fatal(e)
		}
		if e := os.Mkdir(original, 0700); e != nil {
			t.Fatal(e)
		}
		os.WriteFile(filepath.Join(original, "go-store.lock"), nil, 0600)
		_, e := s.List()
		requireCode(t, e, "LIBRARY_BUSY")
	})
}
func TestBatchCrashRecoveryPreservesRawArchiveAndMappings(t *testing.T) {
	for _, point := range []string{"after-install", "after-index"} {
		t.Run(point, func(t *testing.T) {
			s, root := testStore(t)
			in := batchInput(t, []map[string]any{manifestRecord(1, "one.png")}, map[string][]byte{"nested/one.png": pngBytes(t, 1)})
			p, e := s.PreviewBatch(in)
			if e != nil {
				t.Fatal(e)
			}
			s.fault = func(stage string) error {
				if stage == point {
					return errors.New("crash")
				}
				return nil
			}
			_, e = s.CommitBatch(CommitBatchInput{PreviewID: p.PreviewID, ExpectedVersion: p.Revision, Confirmed: true})
			if e == nil {
				t.Fatal("crash did not trigger")
			}
			s.Close()
			again, e := Open(root)
			if e != nil {
				t.Fatal(e)
			}
			defer again.Close()
			idx, e := again.List()
			if e != nil {
				t.Fatal(e)
			}
			if point == "after-install" {
				if len(idx.Items) != 0 {
					t.Fatal("uncommitted batch became visible")
				}
			} else {
				if len(idx.Items) != 1 {
					t.Fatal("committed batch lost")
				}
				source := mapFromRaw(idx.Items[0].SourceImport)
				var archive string
				json.Unmarshal(source["archiveRel"], &archive)
				raw, e := again.read(archive+"/manifest.json", MaxIndex)
				if e != nil || !bytes.Equal(raw, in.Manifest) {
					t.Fatal("raw archive lost")
				}
				mapping, e := again.read(archive+"/mapping.json", MaxIndex)
				if e != nil || !bytes.Contains(mapping, []byte(`"targetId": 1`)) {
					t.Fatal("source-target mapping lost")
				}
			}
		})
	}
}
func TestDeleteCrashAfterIndexRecoversExactArchivedImage(t *testing.T) {
	s, root := testStore(t)
	r := create(t, s, 1, 1)
	s.fault = func(point string) error {
		if point == "after-index" {
			return errors.New("crash")
		}
		return nil
	}
	_, e := s.Delete(DeleteInput{ID: 1, ExpectedVersion: r.Revision, ExpectedRevision: 1, Confirmed: true})
	if e == nil {
		t.Fatal("crash not triggered")
	}
	s.Close()
	again, e := Open(root)
	if e != nil {
		t.Fatal(e)
	}
	defer again.Close()
	idx, _ := again.List()
	if len(idx.Items) != 0 {
		t.Fatal("deletion not committed")
	}
	archives, _ := os.ReadDir(filepath.Join(root, meta, "recovery"))
	found := false
	for _, d := range archives {
		b, e := os.ReadFile(filepath.Join(root, meta, "recovery", d.Name(), r.Item.Image))
		if e == nil && bytes.Equal(b, pngBytes(t, 1)) {
			found = true
		}
	}
	if !found {
		t.Fatal("deleted bytes not recoverable")
	}
}
