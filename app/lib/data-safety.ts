export class StorageConflictError extends Error {
  constructor() { super("別のタブで保存データが変更されています。最新の内容を確認してから再操作してください。"); }
}

// This guards stale snapshots; localStorage still cannot provide multi-tab transactions.
export function writeSnapshot(storage: Pick<Storage, "getItem" | "setItem">, key: string, expected: string | null, records: unknown) {
  if (storage.getItem(key) !== expected) throw new StorageConflictError();
  const serialized = JSON.stringify(records);
  storage.setItem(key, serialized);
  return serialized;
}

export function uniqueIds(items: { id: string }[]) {
  return items.every((item) => item.id.trim().length > 0) && new Set(items.map((item) => item.id)).size === items.length;
}

export function sameRecord(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
