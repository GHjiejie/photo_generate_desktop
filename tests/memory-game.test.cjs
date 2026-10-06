const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/memory-game.mjs');
const items = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, image_url: `/images/${index + 1}.png`, prompts: { en: `Original ${index + 1}\r\n` } }));
const pairKeys = (game, id) => game.cards.filter(card => card.itemId === id).map(card => card.key);
const record = (turns, completedAt = 100) => ({ turns, completedAt });

test('memory draws only supported available difficulties with two cards for every unique original image', async () => {
  const { uniqueMemoryItems, availablePairCounts, createMemoryGame } = await model;
  for (let size = 0; size <= 20; size++) {
    const pool = items(size), before = JSON.stringify(pool);
    assert.deepEqual(availablePairCounts(pool), [2, 4, 6, 8].filter(count => count <= size));
    assert.equal(uniqueMemoryItems([...pool, ...pool]).length, size);
    if (size < 2) { assert.equal(createMemoryGame(pool, 2), null); continue; }
    for (const pairs of availablePairCounts(pool)) {
      const game = createMemoryGame([...pool, ...pool], pairs, () => .25);
      assert.equal(game.pairCount, pairs); assert.equal(game.cards.length, pairs * 2);
      assert.equal(new Set(game.cards.map(card => card.key)).size, pairs * 2);
      const counts = new Map();
      for (const card of game.cards) {
        assert.ok(pool.some(item => item.id === card.itemId));
        counts.set(card.itemId, (counts.get(card.itemId) ?? 0) + 1);
      }
      assert.equal(counts.size, pairs); assert.ok([...counts.values()].every(count => count === 2));
      assert.deepEqual(game, createMemoryGame(pool, pairs, () => .25));
    }
    assert.equal(JSON.stringify(pool), before);
  }
});

test('invalid input identities are discarded and unavailable or corrupt difficulty falls back to a playable default', async () => {
  const { uniqueMemoryItems, createMemoryGame } = await model;
  const first = { id: 1, label: 'first' }, duplicate = { id: 1, label: 'duplicate' }, last = { id: 999999 };
  const hostile = {}; Object.defineProperty(hostile, 'id', { get() { throw new Error('must not run'); } });
  const inherited = Object.create({ id: 3 });
  assert.deepEqual(uniqueMemoryItems([null, [], first, duplicate, last, { id: '1' }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: NaN },
    { id: Infinity }, { id: 1000000 }, { id: Number.MAX_SAFE_INTEGER }, hostile, inherited]), [first, last]);
  assert.equal(uniqueMemoryItems([first])[0], first);
  for (const value of [null, undefined, {}, 'images', [], [null], [first, duplicate]]) assert.equal(createMemoryGame(value, 2), null);
  for (const pairs of [undefined, 0, 1, 3, 5, 10, '4', NaN, Infinity, -2]) {
    assert.equal(createMemoryGame(items(10), pairs, () => 0).pairCount, 4);
    assert.equal(createMemoryGame(items(3), pairs, () => 0).pairCount, 2);
  }
  assert.equal(createMemoryGame(items(3), 8, () => 0).pairCount, 2);
});

test('broken random sources never create missing, duplicate, or extra image pairs', async () => {
  const { createMemoryGame } = await model;
  const sources = [() => -100, () => 100, () => 1, () => NaN, () => Infinity, () => '0.5', () => undefined,
    () => { throw new Error('unavailable'); }, null, {}];
  for (const random of sources) {
    const game = createMemoryGame(items(20), 8, random);
    assert.equal(game.cards.length, 16); assert.equal(new Set(game.cards.map(card => card.itemId)).size, 8);
    for (const id of new Set(game.cards.map(card => card.itemId))) assert.equal(pairKeys(game, id).length, 2);
    assert.equal(new Set(game.cards.map(card => card.key)).size, 16);
  }
});

test('first flips do not count a turn and matching pairs complete immutably with exactly one turn per pair', async () => {
  const { createMemoryGame, flipMemoryCard, resolveMemoryMismatch } = await model;
  for (const pairs of [2, 4, 6, 8]) {
    let game = createMemoryGame(items(10), pairs, () => .25);
    const ids = [...new Set(game.cards.map(card => card.itemId))], original = JSON.stringify(game);
    for (let index = 0; index < pairs; index++) {
      const [first, second] = pairKeys(game, ids[index]), prior = game;
      game = flipMemoryCard(game, first);
      assert.deepEqual(game.faceUp, [first]); assert.equal(game.turns, index); assert.notEqual(game, prior);
      assert.equal(flipMemoryCard(game, first), game); assert.equal(resolveMemoryMismatch(game), game);
      const half = game;
      game = flipMemoryCard(game, second);
      assert.equal(game.turns, index + 1); assert.deepEqual(game.faceUp, []); assert.equal(game.matchedIds.length, index + 1);
      assert.deepEqual(half.faceUp, [first]); assert.equal(half.turns, index);
      assert.equal(flipMemoryCard(game, first), game); assert.equal(flipMemoryCard(game, second), game);
    }
    assert.equal(game.status, 'won'); assert.equal(game.turns, pairs);
    assert.equal(flipMemoryCard(game, game.cards[0].key), game); assert.equal(resolveMemoryMismatch(game), game);
    assert.equal(JSON.parse(original).matchedIds.length, 0);
  }
});

test('a mismatch blocks further flips until resolution and counts only its second card as a turn', async () => {
  const { createMemoryGame, flipMemoryCard, resolveMemoryMismatch } = await model;
  let game = createMemoryGame(items(4), 4, () => .5);
  const first = game.cards[0], second = game.cards.find(card => card.itemId !== first.itemId);
  const initial = game;
  game = flipMemoryCard(game, first.key); game = flipMemoryCard(game, second.key);
  assert.deepEqual(game.faceUp, [first.key, second.key]); assert.equal(game.turns, 1); assert.deepEqual(game.matchedIds, []);
  for (const card of game.cards) assert.equal(flipMemoryCard(game, card.key), game);
  const mismatch = game; game = resolveMemoryMismatch(game);
  assert.notEqual(game, mismatch); assert.deepEqual(game.faceUp, []); assert.equal(game.turns, 1);
  assert.deepEqual(mismatch.faceUp, [first.key, second.key]); assert.deepEqual(initial.faceUp, []);
  game = flipMemoryCard(game, first.key); assert.equal(game.turns, 1);
  game = flipMemoryCard(game, pairKeys(game, first.itemId).find(key => key !== first.key));
  assert.equal(game.turns, 2); assert.deepEqual(game.matchedIds, [first.itemId]);
});

test('invalid keys and corrupt state cannot mutate an active round', async () => {
  const { createMemoryGame, flipMemoryCard, resolveMemoryMismatch } = await model;
  const game = createMemoryGame(items(4), 4, () => .25);
  for (const key of [null, undefined, '', 0, {}, 'missing']) assert.equal(flipMemoryCard(game, key), game);
  const invalid = [null, undefined, {}, { ...game, pairCount: 3 }, { ...game, cards: game.cards.slice(1) },
    { ...game, cards: [...game.cards.slice(1), game.cards[1]] }, { ...game, faceUp: ['missing'] },
    { ...game, faceUp: [game.cards[0].key, game.cards[0].key] }, { ...game, matchedIds: [999999] },
    { ...game, faceUp: [game.cards[0].key, game.cards.find(card => card.itemId !== game.cards[0].itemId).key] },
    { ...game, turns: -1 }, { ...game, turns: .5 }, { ...game, status: 'won' }];
  for (const value of invalid) {
    assert.equal(flipMemoryCard(value, game.cards[0].key), value);
    assert.equal(resolveMemoryMismatch(value), value);
  }
});

test('only fewer turns improve a difficulty record and other difficulties and tied timestamps stay intact', async () => {
  const { recordMemoryWin } = await model;
  const first = recordMemoryWin({}, 4, 6, { now: 100 });
  assert.deepEqual(first, { ok: true, improved: true, records: { 4: record(6) } });
  const two = recordMemoryWin(first.records, 2, 2, { now: 200 });
  assert.deepEqual(two.records, { 2: record(2, 200), 4: record(6) });
  const best = recordMemoryWin(two.records, 4, 4, { now: 300 });
  assert.deepEqual(best.records, { 2: record(2, 200), 4: record(4, 300) });
  for (const turns of [4, 5, 100]) assert.deepEqual(recordMemoryWin(best.records, 4, turns, { now: 400 }), { ok: true, improved: false, records: best.records });
  assert.deepEqual(first.records, { 4: record(6) });
  for (const [pairs, turns] of [[1, 1], [3, 3], [10, 10], [4, 3], [4, -1], [4, 4.5], ['4', 4], [4, Infinity]]) {
    assert.deepEqual(recordMemoryWin(best.records, pairs, turns), { ok: false, improved: false, error: 'memory.invalidRecord' });
  }
});

test('corrupt stored records are discarded without executing accessors or preserving unexpected properties', async () => {
  const { sanitizeMemoryRecords } = await model;
  const getter = {}; Object.defineProperty(getter, 'turns', { get() { throw new Error('must not run'); } });
  const records = { 2: record(2, 0), 4: record(3), 6: record(8, 8640000000000000), 8: getter, 3: record(3), extra: 'ignored' };
  assert.deepEqual(sanitizeMemoryRecords(records), { 2: record(2, 0), 6: record(8, 8640000000000000) });
  for (const value of [null, [], 'records', Object.create({ 2: record(2) })]) assert.deepEqual(sanitizeMemoryRecords(value), {});
  for (const value of [record(2, -1), record(2, NaN), record(2, 8640000000000001), record(2, .5), record('2'), record(Infinity)]) {
    assert.deepEqual(sanitizeMemoryRecords({ 2: value }), {});
  }
  const hostile = {}; Object.defineProperty(hostile, '2', { get() { throw new Error('must not run'); } });
  assert.deepEqual(sanitizeMemoryRecords(hostile), {});
  const clean = sanitizeMemoryRecords({ 4: { turns: 4, completedAt: 100, extra: 'ignored' } });
  assert.deepEqual(clean, { 4: record(4) });
});

test('record storage isolates library scopes, cleans corrupt input, and reports read and write failures', async () => {
  const { memoryRecordsStorageKey, readStoredMemoryRecords, writeStoredMemoryRecords } = await model;
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const records = { 2: record(2), 4: record(5) };
  assert.deepEqual(writeStoredMemoryRecords('A', records, storage), { failed: false });
  assert.deepEqual(readStoredMemoryRecords('A', storage), { records, failed: false });
  assert.deepEqual(readStoredMemoryRecords('B', storage), { records: {}, failed: false });
  data.set(memoryRecordsStorageKey('B'), '{bad JSON');
  assert.deepEqual(readStoredMemoryRecords('B', storage), { records: {}, failed: false });
  data.set(memoryRecordsStorageKey('B'), JSON.stringify({ 2: record(0), 4: record(4), 3: record(3) }));
  assert.deepEqual(readStoredMemoryRecords('B', storage), { records: { 4: record(4) }, failed: false });
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(readStoredMemoryRecords('A', denied), { records: {}, failed: true });
  assert.deepEqual(writeStoredMemoryRecords('A', records, denied), { failed: true });
  assert.deepEqual(readStoredMemoryRecords(null, denied), { records: {}, failed: false });
  assert.deepEqual(writeStoredMemoryRecords(null, records, storage), { failed: true });
  assert.deepEqual(records, { 2: record(2), 4: record(5) });
});

test('retrying an unsaved tied win persists the original best record without changing its completion time', async () => {
  const { recordMemoryWin, readStoredMemoryRecords, writeStoredMemoryRecords } = await model;
  const data = new Map(); let denied = true;
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (denied) throw new Error('quota'); data.set(key, value); } };
  const best = recordMemoryWin({}, 4, 4, { now: 100 });
  assert.deepEqual(writeStoredMemoryRecords('A', best.records, storage), { failed: true });
  const nextWin = recordMemoryWin(best.records, 4, 5, { now: 200 });
  assert.equal(nextWin.improved, false); assert.deepEqual(nextWin.records, { 4: record(4, 100) });
  denied = false;
  assert.deepEqual(writeStoredMemoryRecords('A', nextWin.records, storage), { failed: false });
  assert.deepEqual(readStoredMemoryRecords('A', storage), { records: { 4: record(4, 100) }, failed: false });
});
