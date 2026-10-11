import type { Reservation } from "../salon-manager";

export const retentionMs = 72 * 60 * 60 * 1000;
export function expired(item: Reservation, now: number) {
  return item.deletedAt !== undefined && Date.parse(item.deletedAt) + retentionMs <= now;
}
export function hasReservationConflict(item: Reservation, records: Reservation[]) {
  return item.status !== "キャンセル" && records.some((other) => other.id !== item.id && !other.deletedAt && other.status !== "キャンセル" && other.date === item.date && other.time === item.time && other.staff === item.staff);
}
