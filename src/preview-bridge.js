// A development-only, read-only bridge. The desktop build keeps the Electron bridge.
if (import.meta.env.DEV && !window.portraitStudio) {
  const request = async url => {
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      return await response.json();
    } catch { return { ok: false, error: { code: 'UNAVAILABLE' } }; }
  };
  window.portraitStudio = Object.freeze({
    mode: 'browser-preview',
    libraryList: () => request('/__preview/api/library'),
    libraryGet: id => Number.isSafeInteger(id) && id >= 1 && id <= 999999
      ? request(`/__preview/api/portraits/${id}`)
      : Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT' } }),
    copyText: async text => {
      if (typeof text !== 'string' || text.length > 65536) return false;
      await navigator.clipboard.writeText(text); return true;
    },
    openImage: async value => {
      if (!Number.isSafeInteger(value?.id) || !Number.isSafeInteger(value?.revision)) return false;
      const opened = window.open(`/__preview/api/images/${value.id}?revision=${value.revision}`, '_blank', 'noopener,noreferrer');
      // No opener is exposed. A successful popup may deliberately return null.
      return opened === null || Boolean(opened);
    },
  });
}
