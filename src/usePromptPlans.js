import { useEffect, useRef, useState } from 'react';
import { readStoredPromptPlans, writeStoredPromptPlans, savePromptPlan, renamePromptPlan, removePromptPlan } from './prompt-plans.mjs';

const emptyPlans = Object.freeze([]);
function readCollection(scope) {
  const result = readStoredPromptPlans(scope);
  return { scope, plans: result.plans, storageFailed: result.failed, unsaved: false };
}

export default function usePromptPlans(scope) {
  const [collection, setCollection] = useState(() => readCollection(scope));
  const current = useRef(collection);
  const sessions = useRef(new Map([[scope, collection]]));
  const activeScope = useRef(scope);
  activeScope.current = scope;

  useEffect(() => {
    if (current.current.scope === scope) return;
    const cached = sessions.current.get(scope);
    const next = cached?.unsaved ? cached : readCollection(scope);
    sessions.current.set(scope, next);
    current.current = next;
    setCollection(next);
  }, [scope]);

  function mutate(action) {
    if (typeof scope !== 'string' || !scope || activeScope.current !== scope) return { ok: false, error: 'plans.unavailable' };
    const cached = sessions.current.get(scope);
    const base = current.current.scope === scope ? current.current : cached?.unsaved ? cached : readCollection(scope);
    const result = action(base.plans);
    if (!result.ok) return result;
    // Publish to the ref before persistence, so two actions in one event use the
    // latest collection. A failed write still leaves the new session plan usable.
    const next = { scope, plans: result.plans, storageFailed: false, unsaved: false };
    current.current = next;
    next.storageFailed = writeStoredPromptPlans(scope, next.plans).failed;
    next.unsaved = next.storageFailed;
    sessions.current.set(scope, next);
    setCollection(next);
    return { ok: true, ...(result.plan ? { plan: result.plan } : {}) };
  }

  return {
    plans: collection.scope === scope ? collection.plans : emptyPlans,
    storageFailed: collection.scope === scope && collection.storageFailed,
    savePlan: input => mutate(plans => savePromptPlan(plans, input)),
    renamePlan: (id, title) => mutate(plans => renamePromptPlan(plans, id, title)),
    removePlan: id => mutate(plans => removePromptPlan(plans, id))
  };
}
