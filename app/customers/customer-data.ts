import type { Reservation } from "../salon-manager";
import { uniqueIds } from "../lib/data-safety";

export type Customer = {
  id: string;
  name: string;
  phone: string;
  notes: string;
  createdAt: string;
  phoneAliases: string[];
  reservationIds: string[];
  deletedAt?: string;
};

export function normalizePhone(phone: string) {
  const digits = phone.normalize("NFKC").replace(/\D/g, "");
  return digits.startsWith("81") && digits.length >= 11 ? `0${digits.slice(2)}` : digits;
}

export function validPhone(phone: string) {
  return /^\+?[\d\s()-]+$/.test(phone.normalize("NFKC")) && /^\d{10,15}$/.test(normalizePhone(phone));
}

export function isCustomer(value: unknown): value is Customer {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "name", "phone", "notes", "createdAt"].every((key) => typeof item[key] === "string") &&
    validPhone(String(item.phone)) && Number.isFinite(Date.parse(String(item.createdAt))) &&
    Array.isArray(item.phoneAliases) && item.phoneAliases.every((phone) => typeof phone === "string" && /^\d{10,15}$/.test(phone)) &&
    Array.isArray(item.reservationIds) && item.reservationIds.every((id) => typeof id === "string") &&
    (item.deletedAt === undefined || (typeof item.deletedAt === "string" && Number.isFinite(Date.parse(item.deletedAt))));
}

export function isCustomerCollection(value: unknown): value is Customer[] {
  if (!Array.isArray(value) || !value.every(isCustomer) || !uniqueIds(value)) return false;
  const phones = new Map<string, string>();
  const reservations = new Map<string, string>();
  for (const customer of value) {
    for (const phone of new Set([normalizePhone(customer.phone), ...customer.phoneAliases])) {
      if (phones.has(phone) && phones.get(phone) !== customer.id) return false;
      phones.set(phone, customer.id);
    }
    for (const id of customer.reservationIds) {
      if (!id.trim() || (reservations.has(id) && reservations.get(id) !== customer.id)) return false;
      reservations.set(id, customer.id);
    }
  }
  return true;
}

// Keep stable links outside legacy reservations; never rewrite a reservation to migrate it.
export function associateCustomers(customers: Customer[], reservations: Reservation[], registeredAt: string) {
  const result = customers.map((customer) => ({ ...customer, phoneAliases: [...customer.phoneAliases], reservationIds: [...customer.reservationIds] }));
  let changed = false;
  for (const reservation of reservations) {
    if (!validPhone(reservation.phone)) continue;
    const phone = normalizePhone(reservation.phone);
    let customer = result.find((entry) => entry.reservationIds.includes(reservation.id));
    if (!customer) customer = result.find((entry) => normalizePhone(entry.phone) === phone || entry.phoneAliases.includes(phone));
    if (!customer) {
      customer = { id: crypto.randomUUID(), name: reservation.name, phone: reservation.phone, notes: "", createdAt: registeredAt, phoneAliases: [phone], reservationIds: [], };
      result.push(customer);
      changed = true;
    }
    if (!customer.reservationIds.includes(reservation.id)) { customer.reservationIds.push(reservation.id); changed = true; }
  }
  return changed ? result : customers;
}

export function customerHistory(customer: Customer, reservations: Reservation[]) {
  return reservations.filter((item) => customer.reservationIds.includes(item.id)).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}
