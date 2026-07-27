export function themeChain(themes, themeId) {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const result = [];
  const seen = new Set();
  let current = byId.get(themeId);
  while (current && !seen.has(current.id)) {
    result.push(current.id);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return result;
}

export function effectiveImplementations(state, themeId) {
  const chain = themeChain(state.themes, themeId);
  const current = state.themes.find((theme) => theme.id === themeId);
  const hidden = new Set(current?.hiddenInheritedImplementationIds || []);
  return state.implementations
    .filter((implementation) => {
      const direct = implementation.themeIds.includes(themeId);
      const inherited = implementation.themeIds.some((id) => chain.includes(id));
      return inherited && (direct || !hidden.has(implementation.id));
    })
    .map((implementation) => ({
      ...implementation,
      directInTheme: implementation.themeIds.includes(themeId),
      originThemeIds: implementation.themeIds.filter((id) => chain.includes(id)),
    }));
}

export function effectiveConflicts(state, themeId) {
  const chain = themeChain(state.themes, themeId);
  const current = state.themes.find((theme) => theme.id === themeId);
  const applicable = state.conflicts.filter((conflict) => conflict.themeId === null || chain.includes(conflict.themeId));
  const overridden = new Set(applicable.filter((conflict) => conflict.overridesConflictId).map((conflict) => conflict.overridesConflictId));
  const hidden = new Set(current?.hiddenInheritedConflictIds || []);
  return applicable.filter((conflict) => {
    if (overridden.has(conflict.id)) return false;
    const local = conflict.themeId === themeId;
    return local || !hidden.has(conflict.id);
  });
}

export function blockingConflicts(conflicts, lockedIds, candidateId) {
  const locked = new Set(lockedIds);
  return conflicts.filter((conflict) => {
    if (!conflict.implementationIds.includes(candidateId)) return false;
    return conflict.implementationIds.every((id) => id === candidateId || locked.has(id));
  });
}

export function normalizeLocked(conflicts, requestedIds) {
  const result = [];
  for (const id of requestedIds) {
    if (blockingConflicts(conflicts, result, id).length === 0) result.push(id);
  }
  return result;
}

export function requirementClosure(requirements, requestedIds) {
  const selected = new Set(requestedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const requirement of requirements || []) {
      if (selected.has(requirement.fromImplementationId) && !selected.has(requirement.toImplementationId)) {
        selected.add(requirement.toImplementationId);
        changed = true;
      }
    }
  }
  return [...selected];
}

export function lockWithRequirements(conflicts, requirements, lockedIds, candidateId, availableIds) {
  const locked = requirementClosure(requirements, [...lockedIds, candidateId]);
  const available = availableIds ? new Set(availableIds) : null;
  const missingIds = available ? locked.filter((id) => !available.has(id)) : [];
  const completedConflicts = conflicts.filter((conflict) => conflict.implementationIds.every((id) => locked.includes(id)));
  return { locked, missingIds, completedConflicts };
}

export function normalizeLockedWithRequirements(conflicts, requirements, requestedIds, availableIds) {
  let result = [];
  for (const id of requestedIds) {
    const proposal = lockWithRequirements(conflicts, requirements, result, id, availableIds);
    if (!proposal.missingIds.length && !proposal.completedConflicts.length) result = proposal.locked;
  }
  return result;
}

export function unlockRequirementDependents(requirements, lockedIds, implementationId) {
  return lockedIds.filter((id) => id !== implementationId && !requirementClosure(requirements, [id]).includes(implementationId));
}

export function implementationConflictCount(conflicts, implementationId) {
  return conflicts.filter((conflict) => conflict.implementationIds.includes(implementationId)).length;
}

export function blendBackground(colors) {
  const clean = colors.filter(Boolean);
  if (!clean.length) return 'linear-gradient(135deg, #f8fafc, #eef2f7)';
  if (clean.length === 1) return clean[0];
  const step = 100 / clean.length;
  const stops = clean.flatMap((color, index) => [`${color} ${index * step}%`, `${color} ${(index + 1) * step}%`]);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

export function readableTextColor(colors) {
  const clean = colors.filter(Boolean);
  if (!clean.length) return '#172033';
  const values = clean.map((hex) => {
    const normalized = hex.replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return 230;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return average < 145 ? '#ffffff' : '#172033';
}
