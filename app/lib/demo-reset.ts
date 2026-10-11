import { StorageConflictError } from "./data-safety";

export const demoKeys = ["salon-manager-reservations-v1", "salon-manager-customers-v1"] as const;
type DemoStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function captureDemo(storage: DemoStorage) {
  return demoKeys.map(key => storage.getItem(key));
}

// Only these two application keys are reset; never clear the whole origin.
export function resetDemo(storage: DemoStorage, expected: (string | null)[], reservations: unknown, customers: unknown) {
  if (expected.length !== 2 || demoKeys.some((key, i) => storage.getItem(key) !== expected[i])) throw new StorageConflictError();
  const next = [JSON.stringify(reservations), JSON.stringify(customers)];
  storage.setItem(demoKeys[0], next[0]);
  try {
    if (storage.getItem(demoKeys[1]) !== expected[1]) throw new StorageConflictError();
    storage.setItem(demoKeys[1], next[1]);
  } catch (error) {
    // Roll back only our own write, without overwriting another tab's update.
    try {
      if (storage.getItem(demoKeys[0]) !== next[0]) throw new StorageConflictError();
      if (expected[0] === null) storage.removeItem(demoKeys[0]);
      else storage.setItem(demoKeys[0], expected[0]);
    } catch {
      throw new Error("保存状態を完全に戻せませんでした。画面を再読み込みして保存内容を確認してください。");
    }
    throw error;
  }
}
