const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/inspiration-duel.mjs');
const items = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, image_url: `/images/${index + 1}.png` }));

test('a draw samples at most eight unique identities without mutating or reordering the library', async () => {
  const { drawDuelItems, uniqueDuelItems } = await model;
  const pool = items(20), original = [...pool];
  const duplicate = { ...pool[0], id: '1' };
  const draw = drawDuelItems([...pool, duplicate], () => .25);
  assert.equal(draw.length, 8);
  assert.equal(new Set(draw.map(item => String(item.id))).size, 8);
  assert.ok(draw.every(item => pool.includes(item)));
  assert.deepEqual(pool, original);
  assert.equal(uniqueDuelItems([pool[0], duplicate]).length, 1);
  assert.deepEqual(drawDuelItems(pool, () => .25), draw);
  assert.deepEqual(drawDuelItems(pool, () => 0, 100).length, 8);
  assert.equal(drawDuelItems(pool, () => 0, 3).length, 3);
});

test('every pool size from two to eight ends after exactly n minus one choices, with valid rounds and automatic byes', async () => {
  const { createDuel, currentDuelPair, chooseDuelWinner } = await model;
  for (let size = 2; size <= 8; size += 1) {
    const entrants = items(size);
    let state = createDuel(entrants), choices = 0;
    const eliminated = new Set();
    while (!state.winner) {
      const pair = currentDuelPair(state);
      assert.equal(pair.length, 2);
      assert.ok(pair.every(item => entrants.includes(item) && !eliminated.has(item.id)));
      const prior = state;
      const picked = pair[choices % 2], loser = pair[(choices + 1) % 2];
      state = chooseDuelWinner(state, picked.id);
      eliminated.add(loser.id);
      choices += 1;
      assert.equal(prior.completedMatches, choices - 1);
      assert.equal(state.completedMatches, choices);
      assert.equal(state.totalMatches, size - 1);
      assert.ok(state.round >= prior.round && state.round <= 3);
      assert.ok(choices <= size - 1, `pool ${size} always terminates`);
    }
    assert.equal(choices, size - 1);
    assert.equal(eliminated.size, size - 1);
    assert.ok(!eliminated.has(state.winner.id));
    assert.equal(state.completedMatches, state.totalMatches);
    assert.equal(currentDuelPair(state), null);
    assert.equal(chooseDuelWinner(state, state.winner.id), state);
  }
});

test('odd pools preserve an unpaired image and let it become champion without a phantom match', async () => {
  const { createDuel, currentDuelPair, chooseDuelWinner } = await model;
  let state = createDuel(items(5));
  state = chooseDuelWinner(state, 1);
  state = chooseDuelWinner(state, 3);
  assert.equal(state.round, 2);
  assert.deepEqual(state.entrants.map(item => item.id), [1, 3, 5]);
  assert.deepEqual(currentDuelPair(state).map(item => item.id), [1, 3]);
  assert.equal(state.completedMatches, 2);
  state = chooseDuelWinner(state, 3);
  assert.equal(state.round, 3);
  assert.deepEqual(currentDuelPair(state).map(item => item.id), [3, 5]);
  state = chooseDuelWinner(state, 5);
  assert.equal(state.winner.id, 5);
  assert.equal(state.completedMatches, 4);
});

test('immutable match snapshots can undo across a round transition and the champion screen', async () => {
  const { createDuel, currentDuelPair, chooseDuelWinner } = await model;
  const history = [];
  let state = createDuel(items(3));
  history.push(state);
  state = chooseDuelWinner(state, 1);
  history.push(state);
  state = chooseDuelWinner(state, 3);
  assert.equal(state.winner.id, 3);
  state = history.pop();
  assert.equal(state.winner, null);
  assert.deepEqual(currentDuelPair(state).map(item => item.id), [1, 3]);
  state = history.pop();
  assert.equal(state.round, 1);
  assert.equal(state.completedMatches, 0);
  assert.deepEqual(currentDuelPair(state).map(item => item.id), [1, 2]);
  assert.deepEqual(state.advancing, []);
});

test('invalid sources and votes cannot create broken draws or change a valid bracket', async () => {
  const { createDuel, drawDuelItems, currentDuelPair, chooseDuelWinner } = await model;
  for (const value of [null, undefined, {}, 'images', [], [null], [{ id: 1 }], [{ id: '' }, { id: NaN }]]) assert.equal(createDuel(value), null);
  assert.equal(createDuel([{ id: 1 }, { id: '1' }]), null);
  assert.deepEqual(drawDuelItems(null), []);
  assert.deepEqual(drawDuelItems(items(3), () => 0, -2), []);
  for (const value of [-10, 10, 1, NaN, Infinity, '0.5', undefined]) {
    const draw = drawDuelItems(items(10), () => value);
    assert.equal(draw.length, 8);
    assert.equal(new Set(draw.map(item => item.id)).size, 8);
  }
  assert.equal(drawDuelItems(items(3), () => { throw new Error('bad random'); }).length, 3);
  const state = createDuel(items(3));
  for (const id of [null, undefined, '', {}, NaN, 3, 999]) assert.equal(chooseDuelWinner(state, id), state);
  assert.equal(chooseDuelWinner(null, 1), null);
  assert.equal(currentDuelPair({ entrants: items(3), pairIndex: -1 }), null);
  assert.equal(chooseDuelWinner(state, '1').entrants[0].id, 1);
});
