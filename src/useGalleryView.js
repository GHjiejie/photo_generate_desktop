import { useEffect, useState } from 'react';

const storageKey = 'portraitStudio.galleryView.v1';
export const gallerySortModes = ['default', 'number-desc', 'name-asc'];

function readView() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return { sort: gallerySortModes.includes(saved?.sort) ? saved.sort : 'default', dense: saved?.dense === true };
  } catch { return { sort: 'default', dense: false }; }
}

export default function useGalleryView() {
  const [view, setView] = useState(() => ({ ...readView(), changed: false }));
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => {
    if (!view.changed) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ sort: view.sort, dense: view.dense }));
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  }, [view]);

  function setSort(sort) {
    if (gallerySortModes.includes(sort)) setView(previous => ({ ...previous, sort, changed: true }));
  }
  function toggleDensity() {
    setView(previous => ({ ...previous, dense: !previous.dense, changed: true }));
  }
  return { sort: view.sort, dense: view.dense, setSort, toggleDensity, storageFailed };
}
