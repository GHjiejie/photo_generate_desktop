export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;
export const tagKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function validateTags(values) {
  if (!Array.isArray(values)) return { error: 'tags.invalid' };
  const tags = [], seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') return { error: 'tags.invalid' };
    const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!name) continue;
    if ([...name].length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) return { error: 'tags.invalid' };
    const key = tagKey(name);
    if (!seen.has(key)) { tags.push(name); seen.add(key); }
  }
  return tags.length > MAX_TAGS ? { error: 'tags.tooMany' } : { tags };
}

export function sanitizeStoredTags(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, names] of Object.entries(value)) {
    if (!/^[1-9]\d{0,5}$/u.test(id) || !Array.isArray(names)) continue;
    const tags = [];
    for (const name of names) {
      const checked = validateTags([name]);
      if (!checked.error) tags.push(...checked.tags);
    }
    const checked = validateTags(tags);
    if (!checked.error && checked.tags.length) result[id] = checked.tags;
  }
  return result;
}

export function tagCatalog(items, tagsById) {
  const catalog = new Map();
  for (const item of items) {
    for (const name of tagsById[item.id] ?? []) {
      const key = tagKey(name), current = catalog.get(key);
      if (current) current.count += 1;
      else catalog.set(key, { key, name, count: 1 });
    }
  }
  return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
}
