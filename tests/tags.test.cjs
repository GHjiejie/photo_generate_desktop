const { test } = require('node:test');
const assert = require('node:assert/strict');

const tags = import('../src/tags.mjs');

test('tags preserve user names while matching case, full-width text and redundant spaces consistently', async () => {
  const { validateTags, tagKey } = await tags;
  assert.deepEqual(validateTags([' Film ', 'Ｆｉｌｍ', 'film', '窗光', '  window   light  ', '']), { tags: ['Film', '窗光', 'window light'] });
  assert.equal(tagKey(' ＦＩＬＭ '), 'film');
  assert.deepEqual(validateTags(['😀'.repeat(32)]), { tags: ['😀'.repeat(32)] });
});

test('tag limits reject an entire invalid edit instead of silently saving partial metadata', async () => {
  const { validateTags } = await tags;
  assert.deepEqual(validateTags(['good', 'x'.repeat(33)]), { error: 'tags.invalid' });
  assert.deepEqual(validateTags(['good', 'bad\0tag']), { error: 'tags.invalid' });
  assert.deepEqual(validateTags([null]), { error: 'tags.invalid' });
  for (const invalid of [null, {}, 'Film']) assert.deepEqual(validateTags(invalid), { error: 'tags.invalid' });
  assert.deepEqual(validateTags(Array.from({ length: 13 }, (_, i) => `tag-${i}`)), { error: 'tags.tooMany' });
  assert.equal(validateTags(Array(20).fill('same')).tags.length, 1);
});

test('damaged preferences cannot introduce invalid item IDs, prototype keys or non-text tags', async () => {
  const { sanitizeStoredTags } = await tags;
  const stored = JSON.parse('{"1":["Film","film",null,"窗光"],"0":["bad"],"01":["bad"],"1000000":["bad"],"__proto__":["bad"],"2":{},"3":["x\\u0000y"],"999999":["valid"]}');
  assert.deepEqual(sanitizeStoredTags(stored), { 1: ['Film', '窗光'], 999999: ['valid'] });
  for (const invalid of [null, 'text', [], 1]) assert.deepEqual(sanitizeStoredTags(invalid), {});
});

test('tag filter counts include only the current library and combine equivalent tag names', async () => {
  const { tagCatalog } = await tags;
  const result = tagCatalog([{ id: 1 }, { id: 2 }], { 1: ['Film', '窗光'], 2: ['film'], 3: ['Unrelated library'] });
  assert.equal(result.find(tag => tag.key === 'film').count, 2);
  assert.equal(result.find(tag => tag.key === '窗光').count, 1);
  assert.equal(result.length, 2);
});
