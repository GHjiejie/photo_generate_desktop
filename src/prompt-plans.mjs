import { MAX_DRAFT_LENGTH } from './creative-lab.mjs';

export const MAX_PLANS = 30;
export const MAX_PLAN_TITLE_LENGTH = 80;
const MAX_DATE = 8640000000000000;
const MAX_DIFF_LINES = 2048;
const MAX_DIFF_CELLS = 250000;
let fallbackSequence = 0;

const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(id);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;

export function validatePlanTitle(value) {
  if (typeof value !== 'string') return { ok: false, error: 'plans.invalidTitle' };
  const title = value.trim().replace(/\s+/gu, ' ');
  if (!title) return { ok: false, error: 'plans.invalidTitle' };
  if (title.length > MAX_PLAN_TITLE_LENGTH) return { ok: false, error: 'plans.titleTooLong' };
  return { ok: true, title };
}

export function validatePlanDrafts(value) {
  if (!record(value)) return { ok: false, error: 'plans.invalidDraft' };
  const drafts = { zh: '', en: '' };
  for (const language of ['zh', 'en']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, language);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return { ok: false, error: 'plans.invalidDraft' };
    if (descriptor.value.length > MAX_DRAFT_LENGTH) return { ok: false, error: 'plans.tooLong' };
    drafts[language] = descriptor.value;
  }
  if (!drafts.zh.trim() && !drafts.en.trim()) return { ok: false, error: 'plans.emptyDraft' };
  return { ok: true, drafts };
}

// Stored records are data only. Invalid records are discarded as a whole, so an
// oversized or malformed bilingual draft never becomes a partial saved plan.
export function sanitizeStoredPlans(value) {
  if (!Array.isArray(value)) return [];
  const plans = [], ids = new Set();
  for (const entry of value) {
    if (!record(entry)) continue;
    const id = field(entry, 'id'), createdAt = field(entry, 'createdAt'), updatedAt = field(entry, 'updatedAt');
    const title = validatePlanTitle(field(entry, 'title'));
    const drafts = validatePlanDrafts(field(entry, 'drafts'));
    if (!validId(id) || ids.has(id) || !validTime(createdAt) || !validTime(updatedAt)
      || updatedAt < createdAt || !title.ok || !drafts.ok) continue;
    plans.push({ id, title: title.title, drafts: drafts.drafts, createdAt, updatedAt });
    ids.add(id);
    if (plans.length === MAX_PLANS) break;
  }
  return plans;
}

function timestamp(now) {
  let value = now;
  if (typeof now === 'function') {
    try { value = now(); } catch { value = undefined; }
  }
  return validTime(value) ? value : Date.now();
}

function createId(occupied, idFactory, now) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let id;
    try { id = typeof idFactory === 'function' ? idFactory() : globalThis.crypto?.randomUUID?.(); } catch { /* Fall back to a session counter. */ }
    if (validId(id) && !occupied.has(id)) return id;
  }
  let id;
  do { id = `plan-${now.toString(36)}-${(++fallbackSequence).toString(36)}`; } while (occupied.has(id));
  return id;
}

export function savePromptPlan(existing, input, options = {}) {
  if (!record(input)) return { ok: false, error: 'plans.invalidDraft' };
  const title = validatePlanTitle(field(input, 'title'));
  if (!title.ok) return title;
  const drafts = validatePlanDrafts(field(input, 'drafts'));
  if (!drafts.ok) return drafts;
  const plans = sanitizeStoredPlans(existing);
  if (plans.length >= MAX_PLANS) return { ok: false, error: 'plans.full' };
  const now = timestamp(options.now);
  const plan = { id: createId(new Set(plans.map(item => item.id)), options.idFactory, now),
    title: title.title, drafts: drafts.drafts, createdAt: now, updatedAt: now };
  return { ok: true, plan, plans: [plan, ...plans] };
}

export function renamePromptPlan(existing, id, value, options = {}) {
  const plans = sanitizeStoredPlans(existing), index = plans.findIndex(plan => plan.id === id);
  if (index < 0) return { ok: false, error: 'plans.notFound' };
  const title = validatePlanTitle(value);
  if (!title.ok) return title;
  const original = plans[index];
  const plan = title.title === original.title ? original
    : { ...original, title: title.title, updatedAt: Math.max(original.updatedAt, timestamp(options.now)) };
  return { ok: true, plan, plans: plans.map(item => item.id === id ? plan : item) };
}

export function removePromptPlan(existing, id) {
  const plans = sanitizeStoredPlans(existing), plan = plans.find(item => item.id === id);
  if (!plan) return { ok: false, error: 'plans.notFound' };
  return { ok: true, plan, plans: plans.filter(item => item.id !== id) };
}

export const promptPlansStorageKey = scope => `portraitStudio.promptPlans.v1.${scope}`;

export function readStoredPromptPlans(scope, storage) {
  if (typeof scope !== 'string' || !scope) return { plans: [], failed: false };
  let raw;
  try { raw = (storage ?? globalThis.localStorage).getItem(promptPlansStorageKey(scope)); }
  catch { return { plans: [], failed: true }; }
  if (raw === null) return { plans: [], failed: false };
  try { return { plans: sanitizeStoredPlans(JSON.parse(raw)), failed: false }; }
  catch { return { plans: [], failed: false }; }
}

export function writeStoredPromptPlans(scope, plans, storage) {
  if (typeof scope !== 'string' || !scope) return { failed: true };
  try { (storage ?? globalThis.localStorage).setItem(promptPlansStorageKey(scope), JSON.stringify(plans)); return { failed: false }; }
  catch { return { failed: true }; }
}

function countLines(text) {
  if (!text) return 0;
  let count = 0, position = -1;
  while ((position = text.indexOf('\n', position + 1)) >= 0) count++;
  return count + (text.endsWith('\n') ? 0 : 1);
}

const splitLines = text => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

// Each text includes its original line terminator. Concatenating same+removed
// exactly reconstructs before, and same+added exactly reconstructs after.
// A bounded LCS handles typical edits; large comparisons retain complete blocks.
export function compareDrafts(before, after) {
  const previous = typeof before === 'string' ? before : '', next = typeof after === 'string' ? after : '';
  const beforeCount = countLines(previous), afterCount = countLines(next);
  if (beforeCount > MAX_DIFF_LINES || afterCount > MAX_DIFF_LINES) {
    if (previous === next) return { lines: previous ? [{ type: 'same', text: previous }] : [], added: 0, removed: 0 };
    return { lines: [...(previous ? [{ type: 'removed', text: previous }] : []), ...(next ? [{ type: 'added', text: next }] : [])],
      added: afterCount, removed: beforeCount };
  }
  const a = splitLines(previous), b = splitLines(next), lines = [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) lines.push({ type: 'same', text: a[prefix++] });
  let aEnd = a.length, bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  const n = aEnd - prefix, m = bEnd - prefix;
  let removed = 0, added = 0;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    if (n) lines.push({ type: 'removed', text: a.slice(prefix, aEnd).join('') });
    if (m) lines.push({ type: 'added', text: b.slice(prefix, bEnd).join('') });
    removed = n; added = m;
  } else {
    // Intern strings before the DP so repeated long lines use numeric equality.
    const symbols = new Map();
    const symbol = text => { if (!symbols.has(text)) symbols.set(text, symbols.size); return symbols.get(text); };
    const aIds = a.slice(prefix, aEnd).map(symbol), bIds = b.slice(prefix, bEnd).map(symbol);
    const width = m + 1, table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = aIds[i] === bIds[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && aIds[i] === bIds[j]) { lines.push({ type: 'same', text: a[prefix + i++] }); j++; }
      else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        lines.push({ type: 'removed', text: a[prefix + i++] }); removed++;
      } else { lines.push({ type: 'added', text: b[prefix + j++] }); added++; }
    }
  }
  for (let i = aEnd; i < a.length; i++) lines.push({ type: 'same', text: a[i] });
  return { lines, added, removed };
}
