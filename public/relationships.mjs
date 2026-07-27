export function fuzzyMatches(value, query) {
  const text = String(value || '').toLowerCase();
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  let index = 0;
  for (const character of needle) { index = text.indexOf(character, index); if (index < 0) return false; index += 1; }
  return true;
}

export function allPairs(ids) {
  const pairs = [];
  for (let left = 0; left < ids.length; left += 1) for (let right = left + 1; right < ids.length; right += 1) pairs.push([ids[left], ids[right]]);
  return pairs;
}

export function requirementEdges(chains) {
  const edges = new Map();
  for (const chain of chains) for (const from of chain.from || []) for (const to of chain.to || []) if (from !== to) edges.set(`${from}:${to}`, { fromImplementationId: from, toImplementationId: to });
  return [...edges.values()];
}

export function validRequirementChains(chains) {
  return chains.filter((chain) => chain.from?.length && chain.to?.length);
}
