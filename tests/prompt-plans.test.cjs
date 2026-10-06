const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/prompt-plans.mjs');

const stored = (overrides = {}) => ({ id: 'plan-1', title: 'Saved plan', drafts: { zh: '主体：成年人\r\n', en: '' }, createdAt: 100, updatedAt: 100, ...overrides });
const reconstruct = (diff, side) => diff.lines.filter(line => line.type === 'same' || line.type === side).map(line => line.text).join('');

test('plans preserve both complete language drafts, normalize only names, and copy snapshots', async () => {
  const { savePromptPlan, MAX_PLAN_TITLE_LENGTH } = await model;
  const drafts = { zh: ' \r\n主体：成年人 😀\r\n  保留每一行\r\n\t', en: '\nSubject: adult 😀\n  Keep every line\n ' };
  const result = savePromptPlan([], { title: '\t 灵感  A\n\t草图  ', drafts }, { idFactory: () => 'fixed-id', now: 100 });
  assert.equal(result.ok, true); assert.equal(result.plan.title, '灵感 A 草图');
  assert.deepEqual(result.plan.drafts, drafts); assert.notEqual(result.plan.drafts, drafts);
  assert.equal(result.plan.createdAt, 100); assert.equal(result.plan.updatedAt, 100);
  drafts.zh = 'changed later'; assert.ok(result.plan.drafts.zh.includes('保留每一行'));
  assert.equal(savePromptPlan([], { title: 'x'.repeat(MAX_PLAN_TITLE_LENGTH), drafts: { en: 'one language' } }).ok, true);
});

test('empty or invalid drafts and oversized bilingual text are rejected without truncation', async () => {
  const { savePromptPlan, validatePlanTitle } = await model;
  const { MAX_DRAFT_LENGTH } = await import('../src/creative-lab.mjs');
  const input = { title: 'Valid title', drafts: { zh: '中'.repeat(MAX_DRAFT_LENGTH), en: 'e'.repeat(MAX_DRAFT_LENGTH) } };
  const saved = savePromptPlan([], input); assert.equal(saved.ok, true); assert.deepEqual(saved.plan.drafts, input.drafts);
  assert.deepEqual(savePromptPlan([], { ...input, drafts: { ...input.drafts, en: `${input.drafts.en}x` } }), { ok: false, error: 'plans.tooLong' });
  for (const drafts of [{}, { zh: ' \r\n', en: '\t' }]) assert.deepEqual(savePromptPlan([], { title: 'Valid', drafts }), { ok: false, error: 'plans.emptyDraft' });
  for (const drafts of [null, [], { zh: 3 }, { zh: 'valid', en: null }]) assert.deepEqual(savePromptPlan([], { title: 'Valid', drafts }), { ok: false, error: 'plans.invalidDraft' });
  assert.deepEqual(validatePlanTitle('  \n '), { ok: false, error: 'plans.invalidTitle' });
  assert.deepEqual(validatePlanTitle('x'.repeat(81)), { ok: false, error: 'plans.titleTooLong' });
});

test('saving equal names creates independent identities and handles colliding or broken id generators', async () => {
  const { savePromptPlan } = await model;
  const first = savePromptPlan([], { title: 'Same', drafts: { zh: 'first' } }, { idFactory: () => 'same-id', now: 100 });
  const second = savePromptPlan(first.plans, { title: 'Same', drafts: { zh: 'second' } }, { idFactory: () => 'same-id', now: 100 });
  assert.equal(second.plans.length, 2); assert.notEqual(first.plan.id, second.plan.id);
  assert.equal(second.plans[1].drafts.zh, 'first'); assert.equal(second.plans[0].drafts.zh, 'second');
  const third = savePromptPlan(second.plans, { title: 'Same', drafts: { en: 'third' } }, { idFactory: () => { throw new Error('unavailable'); }, now: 100 });
  assert.equal(new Set(third.plans.map(plan => plan.id)).size, 3);
});

test('plan capacity and rename/delete behavior retain other snapshots and stable timestamps', async () => {
  const { savePromptPlan, renamePromptPlan, removePromptPlan, MAX_PLANS } = await model;
  let plans = [];
  for (let i = 0; i < MAX_PLANS; i++) plans = savePromptPlan(plans, { title: `Plan ${i}`, drafts: { en: `text ${i}` } }, { idFactory: () => `id-${i}`, now: 100 + i }).plans;
  const original = JSON.stringify(plans);
  assert.deepEqual(savePromptPlan(plans, { title: 'Extra', drafts: { en: 'extra' } }), { ok: false, error: 'plans.full' });
  const renamed = renamePromptPlan(plans, 'id-0', ' \n New\t title ', { now: 200 });
  assert.equal(renamed.plan.id, 'id-0'); assert.equal(renamed.plan.title, 'New title');
  assert.equal(renamed.plan.createdAt, 100); assert.equal(renamed.plan.updatedAt, 200);
  assert.deepEqual(renamed.plan.drafts, { zh: '', en: 'text 0' });
  assert.equal(renamePromptPlan(renamed.plans, 'id-0', 'New title', { now: 300 }).plan.updatedAt, 200);
  assert.equal(renamePromptPlan(renamed.plans, 'id-0', 'Clock back', { now: 90 }).plan.updatedAt, 200);
  assert.equal(removePromptPlan(renamed.plans, 'id-0').plans.length, MAX_PLANS - 1);
  assert.deepEqual(removePromptPlan(plans, 'missing'), { ok: false, error: 'plans.notFound' });
  assert.deepEqual(renamePromptPlan(plans, 'missing', 'Name'), { ok: false, error: 'plans.notFound' });
  assert.equal(JSON.stringify(plans), original);
});

test('corrupt stored records are discarded whole, duplicates are removed, and accessors are never run', async () => {
  const { sanitizeStoredPlans, MAX_PLANS } = await model;
  const { MAX_DRAFT_LENGTH } = await import('../src/creative-lab.mjs');
  const hostile = { id: 'hostile', createdAt: 100, updatedAt: 100, drafts: { zh: 'safe' } };
  Object.defineProperty(hostile, 'title', { get() { throw new Error('must not run'); } });
  const hostileDraft = { en: 'safe' }; Object.defineProperty(hostileDraft, 'zh', { get() { throw new Error('must not run'); } });
  const records = [null, stored({ id: '__proto__', title: 'Data only' }), stored(), stored({ title: 'duplicate ID' }), hostile,
    stored({ id: 'bad-time', updatedAt: 99 }), stored({ id: 'fractional-time', createdAt: 0.5 }),
    stored({ id: 'bad-draft', drafts: { zh: 'valid', en: 'x'.repeat(MAX_DRAFT_LENGTH + 1) } }), stored({ id: 'getter', drafts: hostileDraft }),
    stored({ id: 'bad-title', title: 'x'.repeat(81) }), ...Array.from({ length: 40 }, (_, i) => stored({ id: `extra-${i}` }))];
  const clean = sanitizeStoredPlans(records);
  assert.equal(clean.length, MAX_PLANS); assert.equal(clean[0].id, '__proto__'); assert.equal(clean[1].title, 'Saved plan');
  assert.equal(clean.some(plan => ['bad-time', 'bad-draft', 'getter', 'bad-title', 'fractional-time'].includes(plan.id)), false);
  assert.equal(new Set(clean.map(plan => plan.id)).size, MAX_PLANS);
  assert.deepEqual(sanitizeStoredPlans({ plans: [stored()] }), []);
  assert.deepEqual(sanitizeStoredPlans([Object.assign(Object.create({ title: 'inherited' }), stored())]), []);
});

test('storage keys isolate library scopes and failed persistence leaves the caller’s session data usable', async () => {
  const { readStoredPromptPlans, writeStoredPromptPlans, promptPlansStorageKey, savePromptPlan } = await model;
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const first = savePromptPlan([], { title: 'Library A', drafts: { zh: 'original' } }, { idFactory: () => 'scope-a', now: 100 });
  assert.deepEqual(writeStoredPromptPlans('A', first.plans, storage), { failed: false });
  assert.deepEqual(readStoredPromptPlans('B', storage), { plans: [], failed: false });
  assert.deepEqual(readStoredPromptPlans('A', storage).plans, first.plans);
  data.set(promptPlansStorageKey('B'), '{not JSON'); assert.deepEqual(readStoredPromptPlans('B', storage), { plans: [], failed: false });
  const denied = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(readStoredPromptPlans('A', denied), { plans: [], failed: true });
  assert.deepEqual(writeStoredPromptPlans('A', first.plans, denied), { failed: true });
  assert.equal(first.plan.drafts.zh, 'original');
  assert.deepEqual(readStoredPromptPlans(null, denied), { plans: [], failed: false });
});

test('line differences show exact edits including CRLF, blank lines and missing final newline', async () => {
  const { compareDrafts } = await model;
  const before = '主体：成年人 😀\r\n\r\nLighting: soft\r\n  keep continuation\r\nLast';
  const after = '主体：成年人 😀\r\n\r\nLighting: bright\r\n  keep continuation\r\nLast\n';
  const diff = compareDrafts(before, after);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2);
  assert.ok(diff.lines.some(line => line.type === 'same' && line.text === '\r\n'));
  assert.equal(reconstruct(diff, 'removed'), before); assert.equal(reconstruct(diff, 'added'), after);
  assert.deepEqual(compareDrafts('', ''), { lines: [], added: 0, removed: 0 });
  assert.deepEqual(compareDrafts('unchanged\n', 'unchanged\n'), { lines: [{ type: 'same', text: 'unchanged\n' }], added: 0, removed: 0 });
});

test('large differences use bounded complete blocks and never omit any prompt content', async () => {
  const { compareDrafts } = await model;
  const before = 'prefix\n' + Array.from({ length: 600 }, (_, i) => `old ${i} 中文\n`).join('') + 'suffix\n';
  const after = 'prefix\n' + Array.from({ length: 600 }, (_, i) => `new ${i} English\n`).join('') + 'suffix\n';
  const diff = compareDrafts(before, after);
  assert.equal(diff.lines.length, 4); assert.equal(diff.added, 600); assert.equal(diff.removed, 600);
  assert.equal(reconstruct(diff, 'removed'), before); assert.equal(reconstruct(diff, 'added'), after);
  const huge = 'blank\r\n'.repeat(8000);
  const massive = compareDrafts(huge, `${huge}tail`);
  assert.equal(massive.lines.length, 2); assert.equal(massive.removed, 8000); assert.equal(massive.added, 8001);
  assert.equal(reconstruct(massive, 'removed'), huge); assert.equal(reconstruct(massive, 'added'), `${huge}tail`);
  assert.deepEqual(compareDrafts(huge, huge), { lines: [{ type: 'same', text: huge }], added: 0, removed: 0 });
});

test('repeated-line and mixed-terminator differences reconstruct both sides across varied edits', async () => {
  const { compareDrafts } = await model;
  const samples = ['', '\n', '\r\n', 'a\na\nb\n', 'b\na\n', '😀\r\n中\n\nend', 'no final newline', '\t \n\t \r\n'];
  for (const before of samples) for (const after of samples) {
    const diff = compareDrafts(before, after);
    assert.equal(reconstruct(diff, 'removed'), before); assert.equal(reconstruct(diff, 'added'), after);
    assert.equal(diff.removed, diff.lines.filter(line => line.type === 'removed').length);
    assert.equal(diff.added, diff.lines.filter(line => line.type === 'added').length);
  }
});
