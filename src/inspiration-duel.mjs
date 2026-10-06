export const MAX_DUEL_ITEMS = 8;

const validId = id => (typeof id === 'string' && id.trim() !== '') || (typeof id === 'number' && Number.isFinite(id));

export function uniqueDuelItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.filter(item => {
    if (!item || typeof item !== 'object' || !validId(item.id)) return false;
    const key = String(item.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Shuffle a copy so a round never changes the gallery's order or its own draw.
export function drawDuelItems(items, random = Math.random, limit = MAX_DUEL_ITEMS) {
  const pool = uniqueDuelItems(items);
  const size = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_DUEL_ITEMS, Math.trunc(limit))) : MAX_DUEL_ITEMS;
  for (let index = pool.length - 1; index > 0; index -= 1) {
    let value = 0;
    try { value = typeof random === 'function' ? random() : 0; } catch { /* A broken random source still gives a valid draw. */ }
    const unit = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0;
    const other = Math.floor(unit * (index + 1));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  return pool.slice(0, size);
}

export function createDuel(items) {
  const entrants = uniqueDuelItems(items).slice(0, MAX_DUEL_ITEMS);
  if (entrants.length < 2) return null;
  return { entrants, advancing: [], pairIndex: 0, round: 1, completedMatches: 0, totalMatches: entrants.length - 1, winner: null };
}

export function currentDuelPair(state) {
  if (!state || state.winner || !Array.isArray(state.entrants) || !Number.isInteger(state.pairIndex) || state.pairIndex < 0) return null;
  const pair = state.entrants.slice(state.pairIndex * 2, state.pairIndex * 2 + 2);
  return pair.length === 2 ? pair : null;
}

export function chooseDuelWinner(state, winnerId) {
  const pair = currentDuelPair(state);
  if (!pair || !validId(winnerId)) return state;
  const chosen = pair.find(item => String(item.id) === String(winnerId));
  if (!chosen) return state;
  const advancing = [...state.advancing, chosen];
  const completedMatches = state.completedMatches + 1;
  const pairIndex = state.pairIndex + 1;
  if (pairIndex < Math.floor(state.entrants.length / 2)) return { ...state, advancing, pairIndex, completedMatches };

  // An odd final entrant advances without a phantom match or a user choice.
  if (state.entrants.length % 2) advancing.push(state.entrants.at(-1));
  if (advancing.length === 1) return { ...state, entrants: advancing, advancing: [], pairIndex: 0, completedMatches, winner: advancing[0] };
  return { ...state, entrants: advancing, advancing: [], pairIndex: 0, completedMatches, round: state.round + 1 };
}
