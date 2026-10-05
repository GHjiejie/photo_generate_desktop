import { useEffect, useMemo, useState } from 'react';

const emptyFavorites = new Set();
const storageKey = scope => `portraitStudio.favorites.v1.${scope}`;

function readFavorites(scope) {
  if (!scope) return new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(scope)) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter(id => Number.isSafeInteger(id) && id >= 1 && id <= 999999) : []);
  } catch { return new Set(); }
}

// A collection is loaded before it can be saved. Changing libraries must never
// write the previous library's favorites under the new library's storage key.
export default function useFavorites(scope, items) {
  const [collection, setCollection] = useState(() => ({ scope, ids: readFavorites(scope), changed: false }));
  const [storageFailed, setStorageFailed] = useState(false);
  const available = useMemo(() => new Set(items.map(item => item.id)), [items]);

  useEffect(() => {
    setCollection(previous => previous.scope === scope ? previous : { scope, ids: readFavorites(scope), changed: false });
    setStorageFailed(false);
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    setCollection(previous => {
      if (previous.scope !== scope || [...previous.ids].every(id => available.has(id))) return previous;
      return { scope, ids: new Set([...previous.ids].filter(id => available.has(id))), changed: true };
    });
  }, [scope, available, collection.scope]);

  useEffect(() => {
    if (!scope || collection.scope !== scope || !collection.changed) return;
    try {
      localStorage.setItem(storageKey(scope), JSON.stringify([...collection.ids]));
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  }, [scope, collection]);

  function toggleFavorite(id) {
    if (!scope || !available.has(id)) return;
    setCollection(previous => {
      const ids = new Set(previous.scope === scope ? previous.ids : readFavorites(scope));
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return { scope, ids, changed: true };
    });
  }

  return { favoriteIds: collection.scope === scope ? collection.ids : emptyFavorites, toggleFavorite, storageFailed };
}
