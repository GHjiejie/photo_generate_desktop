import { useEffect, useMemo, useState } from 'react';
import { sanitizeStoredTags, validateTags } from './tags.mjs';

const emptyTags = Object.freeze({});
const storageKey = scope => `portraitStudio.tags.v1.${scope}`;
function readTags(scope) {
  if (!scope) return {};
  try { return sanitizeStoredTags(JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}')); }
  catch { return {}; }
}

export default function useTags(scope, items) {
  const [collection, setCollection] = useState(() => ({ scope, tags: readTags(scope), changed: false }));
  const [storageFailed, setStorageFailed] = useState(false);
  const available = useMemo(() => new Set(items.map(item => String(item.id))), [items]);
  useEffect(() => {
    setCollection(previous => previous.scope === scope ? previous : { scope, tags: readTags(scope), changed: false });
    setStorageFailed(false);
  }, [scope]);
  useEffect(() => {
    if (!scope) return;
    setCollection(previous => {
      if (previous.scope !== scope || Object.keys(previous.tags).every(id => available.has(id))) return previous;
      return { scope, tags: Object.fromEntries(Object.entries(previous.tags).filter(([id]) => available.has(id))), changed: true };
    });
  }, [scope, available, collection.scope]);
  useEffect(() => {
    if (!scope || collection.scope !== scope || !collection.changed) return;
    try { localStorage.setItem(storageKey(scope), JSON.stringify(collection.tags)); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  }, [scope, collection]);

  function setTags(id, values) {
    const checked = validateTags(values);
    if (!scope || !available.has(String(id)) || checked.error) return;
    setCollection(previous => {
      const tags = { ...(previous.scope === scope ? previous.tags : readTags(scope)) };
      if (checked.tags.length) tags[id] = checked.tags; else delete tags[id];
      return { scope, tags, changed: true };
    });
  }
  return { tagsById: collection.scope === scope ? collection.tags : emptyTags, setTags, storageFailed };
}
