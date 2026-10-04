package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
)

type installBytes struct {
	rel   string
	bytes []byte
}
type installEntry struct {
	Stage  string `json:"stage"`
	Final  string `json:"final"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type removeEntry struct {
	Rel    string `json:"rel"`
	SHA256 string `json:"sha256"`
}
type journal struct {
	SchemaVersion int            `json:"schemaVersion"`
	ID            string         `json:"id"`
	BeforeHash    string         `json:"beforeHash"`
	AfterHash     string         `json:"afterHash"`
	Installs      []installEntry `json:"installs"`
	Removes       []removeEntry  `json:"removes"`
	CreatedAt     string         `json:"createdAt"`
}

func (s *Store) transact(id string, before []byte, after Snapshot, installs []installBytes, removes []removeEntry) error {
	return s.transactSources(id, before, after, installs, nil, removes)
}
func (s *Store) transactSources(id string, before []byte, after Snapshot, installs []installBytes, sources map[string]string, removes []removeEntry) (err error) {
	raw, e := checkIndexSize(after)
	if e != nil {
		return e
	}
	if !tokenPattern.MatchString(id) {
		return fail("INVALID_DATA", "Invalid transaction ID")
	}
	tx := meta + "/go-transactions/" + id
	if e = s.mkdir(tx); e != nil {
		return e
	}
	if e = s.writeExclusive(tx+"/before.json", before); e != nil {
		return e
	}
	if e = s.writeExclusive(tx+"/after.json", raw); e != nil {
		return e
	}
	j := journal{SchemaVersion: 1, ID: id, BeforeHash: digest(before), AfterHash: digest(raw), Installs: []installEntry{}, Removes: removes, CreatedAt: utcNow()}
	add := func(final string, b []byte) error {
		if !transactionFinal(final, id) {
			return fail("UNSAFE_PATH", "Invalid transaction target")
		}
		stage := fmt.Sprintf("%s/new-%04d", tx, len(j.Installs))
		if e = s.writeExclusive(stage, b); e != nil {
			return e
		}
		j.Installs = append(j.Installs, installEntry{stage, final, digest(b), int64(len(b))})
		return nil
	}
	for _, v := range installs {
		if e = add(v.rel, v.bytes); e != nil {
			return e
		}
	}
	for _, final := range sortedKeys(sources) {
		source := sources[final]
		b, e := s.read(source, MaxImage)
		if e != nil {
			return e
		}
		if e = add(final, b); e != nil {
			return e
		}
	}
	jb, _ := encode(j)
	if e = s.writeExclusive(tx+"/journal.json", jb); e != nil {
		return e
	}
	// A private test-only hook emulates process death; normal I/O errors recover.
	simulatedCrash := false
	defer func() {
		if err != nil && !simulatedCrash {
			if recoveryErr := s.recoverJournal(tx, j); recoveryErr != nil {
				err = fail("RECOVERY_CONFLICT", "Transaction failed and needs recovery; original journal retained")
			}
		}
	}()
	fault := func(point string) error {
		if s.fault != nil {
			if e := s.fault(point); e != nil {
				simulatedCrash = true
				return e
			}
		}
		return nil
	}
	if e = fault("after-journal"); e != nil {
		return e
	}
	for _, f := range j.Installs {
		if _, e = s.check(f.Stage, false); e != nil {
			return e
		}
		if info, e := s.check(f.Final, true); e != nil {
			return e
		} else if info != nil {
			return fail("CONFLICT", "Transaction target exists")
		}
		if e = s.root.Link(f.Stage, f.Final); e != nil {
			return e
		}
		if e = s.root.Remove(f.Stage); e != nil {
			return e
		}
		if e = s.syncDir(path.Dir(f.Final)); e != nil {
			return e
		}
		if e = s.syncDir(tx); e != nil {
			return e
		}
	}
	if e = fault("after-install"); e != nil {
		return e
	}
	if e = s.contextErr(); e != nil {
		return e
	}
	if e = s.atomic(indexRel, raw, j.BeforeHash); e != nil {
		return e
	}
	s.indexHash = j.AfterHash
	if e = fault("after-index"); e != nil {
		return e
	}
	if e = s.finishRemoves(j); e != nil {
		return e
	}
	if e = fault("before-cleanup"); e != nil {
		return e
	}
	return s.removeOwnedTree(tx)
}
func transactionFinal(rel, id string) bool {
	if !safeRelative(rel) {
		return false
	}
	if imagePattern.MatchString(rel) {
		return strings.Contains(path.Base(rel), "-"+id+".")
	}
	if strings.HasPrefix(rel, meta+"/imports/"+id+"/") {
		name := strings.TrimPrefix(rel, meta+"/imports/"+id+"/")
		return name == "manifest.json" || name == "mapping.json" || name == "source.json"
	}
	if strings.HasPrefix(rel, meta+"/recovery/"+id+"/") {
		name := strings.TrimPrefix(rel, meta+"/recovery/"+id+"/")
		return name == "item.json" || !strings.Contains(name, "/") && imagePattern.MatchString("assets/images/"+name)
	}
	return false
}
func (s *Store) finishRemoves(j journal) error {
	for _, f := range j.Removes {
		if !imagePattern.MatchString(f.Rel) || !hashPattern.MatchString(f.SHA256) {
			return fail("RECOVERY_CONFLICT", "Invalid removal record")
		}
		b, e := s.read(f.Rel, MaxImage)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return e
		}
		if digest(b) != f.SHA256 {
			return fail("RECOVERY_CONFLICT", "Original image changed; archive and original preserved")
		}
		if e = s.root.Remove(f.Rel); e != nil {
			return e
		}
		if e = s.syncDir(path.Dir(f.Rel)); e != nil {
			return e
		}
	}
	return nil
}
func (s *Store) validateJournal(tx string, j journal) error {
	if j.SchemaVersion != 1 || !tokenPattern.MatchString(j.ID) || tx != meta+"/go-transactions/"+j.ID || !hashPattern.MatchString(j.BeforeHash) || !hashPattern.MatchString(j.AfterHash) || len(j.Installs) > MaxRecords+3 || len(j.Removes) > 1 {
		return fail("RECOVERY_CONFLICT", "Invalid transaction journal")
	}
	before, e := s.read(tx+"/before.json", MaxIndex)
	if e != nil || digest(before) != j.BeforeHash {
		return fail("RECOVERY_CONFLICT", "Before-index backup is invalid")
	}
	after, e := s.read(tx+"/after.json", MaxIndex)
	if e != nil || digest(after) != j.AfterHash {
		return fail("RECOVERY_CONFLICT", "After-index backup is invalid")
	}
	var old, new Snapshot
	if json.Unmarshal(before, &old) != nil || json.Unmarshal(after, &new) != nil || validateSnapshot(old) != nil || validateSnapshot(new) != nil || new.Revision != old.Revision+1 {
		return fail("RECOVERY_CONFLICT", "Transaction index snapshots are invalid")
	}
	seen := map[string]bool{}
	for n, f := range j.Installs {
		if f.Stage != fmt.Sprintf("%s/new-%04d", tx, n) || !transactionFinal(f.Final, j.ID) || !hashPattern.MatchString(f.SHA256) || f.Size < 1 || f.Size > MaxIndex || seen[f.Final] {
			return fail("RECOVERY_CONFLICT", "Invalid transaction file entry")
		}
		seen[f.Final] = true
	}
	for _, f := range j.Removes {
		if !imagePattern.MatchString(f.Rel) || !hashPattern.MatchString(f.SHA256) {
			return fail("RECOVERY_CONFLICT", "Invalid transaction removal")
		}
		found := false
		for _, oldItem := range old.Items {
			if oldItem.ImageRel == f.Rel && oldItem.SHA256 == f.SHA256 {
				for _, inst := range j.Installs {
					if inst.Final == meta+"/recovery/"+j.ID+"/"+oldItem.Image && inst.SHA256 == oldItem.SHA256 {
						found = true
					}
				}
			}
		}
		if !found {
			return fail("RECOVERY_CONFLICT", "Removal has no exact recoverable image archive")
		}
	}
	return nil
}
func (s *Store) recoverJournal(tx string, j journal) error {
	if e := s.validateJournal(tx, j); e != nil {
		return e
	}
	current, e := s.read(indexRel, MaxIndex)
	if e != nil {
		return e
	}
	h := digest(current)
	if h == j.AfterHash {
		for _, f := range j.Installs {
			b, e := s.read(f.Final, MaxIndex)
			if e != nil || int64(len(b)) != f.Size || digest(b) != f.SHA256 {
				return fail("RECOVERY_CONFLICT", "Committed file is missing or changed; transaction retained")
			}
		}
		if e = s.finishRemoves(j); e != nil {
			return e
		}
		s.indexHash = j.AfterHash
		return s.removeOwnedTree(tx)
	}
	if h != j.BeforeHash {
		return fail("RECOVERY_CONFLICT", "Index changed during recovery; all files retained")
	}
	recovery := meta + "/recovery/" + j.ID
	if e = s.mkdir(recovery); e != nil {
		return e
	}
	rollback := recovery + "/uncommitted"
	if e = s.mkdir(rollback); e != nil {
		return e
	}
	for n, f := range j.Installs {
		b, e := s.read(f.Final, MaxIndex)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil || digest(b) != f.SHA256 || int64(len(b)) != f.Size {
			return fail("RECOVERY_CONFLICT", "Uncommitted file changed; retained")
		}
		target := fmt.Sprintf("%s/%04d-%s", rollback, n, path.Base(f.Final))
		if e = s.movePreserved(f.Final, target); e != nil {
			return e
		}
	}
	// Preserve the exact interrupted transaction rather than deleting its journal.
	preserved := recovery + "/transaction"
	if e = s.movePreserved(tx, preserved); e != nil {
		return e
	}
	s.indexHash = j.BeforeHash
	return nil
}
func (s *Store) recoverTransactions() error {
	names, e := s.directoryNames(meta + "/go-transactions")
	if e != nil {
		return e
	}
	for _, name := range names {
		if !tokenPattern.MatchString(name) {
			return fail("RECOVERY_CONFLICT", "Unrecognized transaction directory")
		}
		tx := meta + "/go-transactions/" + name
		b, e := s.read(tx+"/journal.json", MaxIndex)
		if errors.Is(e, os.ErrNotExist) {
			if e = s.movePreserved(tx, meta+"/recovery/"+name+"-incomplete-transaction"); e != nil {
				return e
			}
			continue
		}
		if e != nil {
			return e
		}
		var j journal
		if json.Unmarshal(b, &j) != nil {
			return fail("RECOVERY_CONFLICT", "Malformed transaction journal retained")
		}
		if e = s.recoverJournal(tx, j); e != nil {
			return e
		}
	}
	return nil
}

func (s *Store) contextErr() error {
	if s.operationContext != nil {
		if e := s.operationContext.Err(); e != nil {
			return fail("ABORTED", "Operation cancelled before commit")
		}
	}
	return nil
}
