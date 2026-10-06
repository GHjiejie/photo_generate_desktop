export const MEMORY_PAIR_COUNTS = Object.freeze([2, 4, 6, 8]);
const MAX_DATE = 8640000000000000;
const validId = id => Number.isSafeInteger(id) && id >= 1 && id <= 999999;
const validPairs = count => MEMORY_PAIR_COUNTS.includes(count);
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const validTime = time => Number.isSafeInteger(time) && time >= 0 && time <= MAX_DATE;
const validTurns = (pairs, turns) => validPairs(pairs) && Number.isSafeInteger(turns) && turns >= pairs;

export function uniqueMemoryItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.filter(item => {
    if (!record(item)) return false;
    const id = field(item, 'id');
    if (!validId(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function availablePairCounts(items) {
  const count = uniqueMemoryItems(items).length;
  return MEMORY_PAIR_COUNTS.filter(pairs => pairs <= count);
}

// Shuffle a copy. Even an invalid or throwing random source leaves every image
// paired exactly twice and never changes the gallery's original order.
function shuffled(values, random) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index--) {
    let sample = 0;
    try { sample = typeof random === 'function' ? random() : 0; } catch { /* Keep a valid deterministic fallback. */ }
    const unit = typeof sample === 'number' && Number.isFinite(sample) ? Math.max(0, Math.min(1 - Number.EPSILON, sample)) : 0;
    const other = Math.floor(unit * (index + 1));
    [next[index], next[other]] = [next[other], next[index]];
  }
  return next;
}

export function createMemoryGame(items, pairs, random = Math.random) {
  const pool = uniqueMemoryItems(items);
  const available = MEMORY_PAIR_COUNTS.filter(count => count <= pool.length);
  if (!available.length) return null;
  const pairCount = available.includes(pairs) ? pairs : available.filter(count => count <= 4).at(-1);
  const selected = shuffled(pool, random).slice(0, pairCount);
  const cards = shuffled(selected.flatMap(item => [item.id, item.id]), random)
    .map((itemId, index) => ({ key: `memory-${index}`, itemId }));
  return { cards, pairCount, faceUp: [], matchedIds: [], turns: 0, status: 'playing' };
}

function playableGame(game) {
  if (!record(game) || !validPairs(game.pairCount) || !Array.isArray(game.cards)
    || game.cards.length !== game.pairCount * 2 || !Array.isArray(game.faceUp) || game.faceUp.length > 2
    || !Array.isArray(game.matchedIds) || !Number.isSafeInteger(game.turns) || game.turns < 0
    || !['playing', 'won'].includes(game.status)) return false;
  const keys = new Map(), counts = new Map();
  for (const card of game.cards) {
    if (!record(card) || typeof card.key !== 'string' || !card.key || keys.has(card.key) || !validId(card.itemId)) return false;
    keys.set(card.key, card.itemId);
    counts.set(card.itemId, (counts.get(card.itemId) ?? 0) + 1);
  }
  if (counts.size !== game.pairCount || [...counts.values()].some(count => count !== 2)) return false;
  const matched = new Set(game.matchedIds);
  if (matched.size !== game.matchedIds.length || [...matched].some(id => !counts.has(id))) return false;
  if (new Set(game.faceUp).size !== game.faceUp.length || game.faceUp.some(key => !keys.has(key) || matched.has(keys.get(key)))) return false;
  if (game.faceUp.length === 2 && keys.get(game.faceUp[0]) === keys.get(game.faceUp[1])) return false;
  if (game.turns < matched.size + (game.faceUp.length === 2 ? 1 : 0)) return false;
  return game.status === 'won'
    ? matched.size === game.pairCount && game.faceUp.length === 0
    : matched.size < game.pairCount;
}

export function flipMemoryCard(game, key) {
  if (!playableGame(game) || game.status !== 'playing' || game.faceUp.length === 2 || game.faceUp.includes(key)) return game;
  const card = game.cards.find(entry => entry.key === key);
  if (!card || game.matchedIds.includes(card.itemId)) return game;
  if (!game.faceUp.length) return { ...game, faceUp: [key] };
  const turns = game.turns + 1;
  if (!Number.isSafeInteger(turns)) return game;
  const first = game.cards.find(entry => entry.key === game.faceUp[0]);
  if (first.itemId !== card.itemId) return { ...game, faceUp: [...game.faceUp, key], turns };
  const matchedIds = [...game.matchedIds, card.itemId];
  return { ...game, faceUp: [], matchedIds, turns, status: matchedIds.length === game.pairCount ? 'won' : 'playing' };
}

export function resolveMemoryMismatch(game) {
  if (!playableGame(game) || game.status !== 'playing' || game.faceUp.length !== 2) return game;
  return { ...game, faceUp: [] };
}

export const memoryRecordsStorageKey = scope => `portraitStudio.memoryRecords.v1.${scope}`;

export function sanitizeMemoryRecords(value) {
  if (!record(value)) return {};
  const records = {};
  for (const pairs of MEMORY_PAIR_COUNTS) {
    const entry = field(value, String(pairs));
    if (!record(entry)) continue;
    const turns = field(entry, 'turns'), completedAt = field(entry, 'completedAt');
    if (validTurns(pairs, turns) && validTime(completedAt)) records[pairs] = { turns, completedAt };
  }
  return records;
}

export function recordMemoryWin(existing, pairCount, turns, options = {}) {
  if (!validTurns(pairCount, turns)) return { ok: false, improved: false, error: 'memory.invalidRecord' };
  const records = sanitizeMemoryRecords(existing), previous = records[pairCount];
  if (previous && previous.turns <= turns) return { ok: true, improved: false, records };
  let completedAt;
  try { completedAt = typeof options.now === 'function' ? options.now() : options.now; } catch { /* Use the current time. */ }
  if (!validTime(completedAt)) completedAt = Date.now();
  return { ok: true, improved: true, records: { ...records, [pairCount]: { turns, completedAt } } };
}

export function readStoredMemoryRecords(scope, storage) {
  if (typeof scope !== 'string' || !scope) return { records: {}, failed: false };
  let raw;
  try { raw = (storage ?? globalThis.localStorage).getItem(memoryRecordsStorageKey(scope)); }
  catch { return { records: {}, failed: true }; }
  if (raw === null) return { records: {}, failed: false };
  try { return { records: sanitizeMemoryRecords(JSON.parse(raw)), failed: false }; }
  catch { return { records: {}, failed: false }; }
}

export function writeStoredMemoryRecords(scope, records, storage) {
  if (typeof scope !== 'string' || !scope) return { failed: true };
  try {
    (storage ?? globalThis.localStorage).setItem(memoryRecordsStorageKey(scope), JSON.stringify(sanitizeMemoryRecords(records)));
    return { failed: false };
  } catch { return { failed: true }; }
}
