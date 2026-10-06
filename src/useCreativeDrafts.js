import { useEffect, useRef, useState } from 'react';
import { MAX_DRAFT_LENGTH, sanitizeDrafts } from './creative-lab.mjs';

const emptyDrafts = Object.freeze({ zh: '', en: '' });
const storageKey = scope => `portraitStudio.creativeDrafts.v1.${scope}`;
function readDrafts(scope) {
  if (!scope) return { ...emptyDrafts };
  try { return sanitizeDrafts(JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}')); }
  catch { return { ...emptyDrafts }; }
}

export default function useCreativeDrafts(scope) {
  const [collection, setCollection] = useState(() => ({ scope, drafts: readDrafts(scope), changed: false }));
  const current = useRef(collection);
  current.current = collection;
  const [storageState, setStorageState] = useState({ scope, failed: false });

  useEffect(() => {
    setCollection(previous => previous.scope === scope ? previous : { scope, drafts: readDrafts(scope), changed: false });
    setStorageState({ scope, failed: false });
  }, [scope]);
  useEffect(() => {
    if (!scope || collection.scope !== scope || !collection.changed) return;
    try { localStorage.setItem(storageKey(scope), JSON.stringify(collection.drafts)); setStorageState({ scope, failed: false }); }
    catch { setStorageState({ scope, failed: true }); }
  }, [scope, collection]);

  function setDraft(language, text) {
    if (!scope) return { error: 'lab.unavailable' };
    if (!['zh', 'en'].includes(language) || typeof text !== 'string') return { error: 'lab.invalidDraft' };
    if (text.length > MAX_DRAFT_LENGTH) return { error: 'lab.tooLong' };
    const drafts = { ...(current.current.scope === scope ? current.current.drafts : readDrafts(scope)), [language]: text };
    const next = { scope, drafts, changed: true };
    current.current = next;
    setCollection(next);
    return { text };
  }
  return { drafts: collection.scope === scope ? collection.drafts : emptyDrafts, setDraft,
    storageFailed: storageState.scope === scope && storageState.failed };
}
