export function ideaOrder(items, orderedIds) {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  for (const item of items) if (rank.has(item.id)) item.sortOrder = rank.get(item.id);
}

export function implementationOrderForIdea(item, ideaId) {
  return item.ideaSortOrders?.[ideaId] ?? item.sortOrder ?? 0;
}

export function implementationOrder(items, ideaId, orderedIds) {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  for (const item of items) {
    if (!rank.has(item.id)) continue;
    item.ideaSortOrders ||= {};
    item.ideaSortOrders[ideaId] = rank.get(item.id);
  }
}
