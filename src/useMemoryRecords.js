import { useEffect, useRef, useState } from 'react';
import { readStoredMemoryRecords, writeStoredMemoryRecords, recordMemoryWin } from './memory-game.mjs';

const emptyRecords = Object.freeze({});
function readCollection(scope) {
  const result = readStoredMemoryRecords(scope);
  return { scope, records: result.records, storageFailed: result.failed, unsaved: false };
}

export default function useMemoryRecords(scope) {
  const [collection, setCollection] = useState(() => readCollection(scope));
  const current = useRef(collection);
  const sessions = useRef(new Map([[scope, collection]]));
  const activeScope = useRef(scope);
  activeScope.current = scope;

  useEffect(() => {
    if (current.current.scope === scope) return;
    const cached = sessions.current.get(scope);
    const next = cached?.unsaved ? cached : readCollection(scope);
    sessions.current.set(scope, next);
    current.current = next;
    setCollection(next);
  }, [scope]);

  function recordWin(pairCount, turns) {
    // A callback captured by the previous library cannot save into either the
    // new library or a stale collection while a scope switch is rendering.
    if (typeof scope !== 'string' || !scope || activeScope.current !== scope) {
      return { ok: false, improved: false, error: 'memory.recordsUnavailable' };
    }
    const cached = sessions.current.get(scope);
    const base = current.current.scope === scope ? current.current : cached?.unsaved ? cached : readCollection(scope);
    const result = recordMemoryWin(base.records, pairCount, turns);
    if (!result.ok) return { ok: false, improved: false, error: result.error };
    if (!result.improved && !base.unsaved) return { ok: true, improved: false };
    // Publish first, so rapid completions always compare against the latest
    // score. A failed write remains usable when switching away and back.
    const next = { scope, records: result.records, storageFailed: false, unsaved: false };
    current.current = next;
    next.storageFailed = writeStoredMemoryRecords(scope, next.records).failed;
    next.unsaved = next.storageFailed;
    sessions.current.set(scope, next);
    setCollection(next);
    return { ok: true, improved: result.improved };
  }

  return {
    records: collection.scope === scope ? collection.records : emptyRecords,
    storageFailed: collection.scope === scope && collection.storageFailed,
    recordWin
  };
}
