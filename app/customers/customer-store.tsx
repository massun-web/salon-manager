"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useReservations } from "../salon-manager";
import { associateCustomers, isCustomerCollection, normalizePhone, validPhone, type Customer } from "./customer-data";
import { StorageConflictError, sameRecord, writeSnapshot } from "../lib/data-safety";

const storageKey = "salon-manager-customers-v1";
type Draft = Pick<Customer, "name" | "phone" | "notes"> & { id?: string };
type CustomerStore = { customers: Customer[]; ready: boolean; notice: string; saveCustomer: (draft: Draft, original?: Customer | null) => string | null; deleteCustomer: (id: string, original?: Customer) => boolean };
const CustomerContext = createContext<CustomerStore | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const reservations = useReservations();
  const [records, setRecords] = useState<Customer[]>([]);
  const recordsRef = useRef<Customer[]>([]);
  const storageSnapshot = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = localStorage.getItem(storageKey);
        let initial: Customer[] = [];
        if (stored !== null) {
          const parsed: unknown = JSON.parse(stored);
          if (!isCustomerCollection(parsed)) throw new Error("Invalid customer data");
          initial = parsed;
        }
        recordsRef.current = initial;
        storageSnapshot.current = stored;
        setRecords(initial);
        setLoaded(true);
      } catch { setNotice("顧客データを読み込めませんでした。既存データ保護のため、上書きせず顧客操作を停止しています。"); }
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed: unknown = raw === null ? [] : JSON.parse(raw);
        if (!isCustomerCollection(parsed)) throw new Error("Invalid customer data");
        recordsRef.current = parsed;
        storageSnapshot.current = raw;
        setRecords(parsed);
        setLoaded(true);
        setNotice("別のタブの顧客変更を反映しました。編集中の場合は最新の内容をご確認ください。");
      } catch {
        setLoaded(false);
        setNotice("別のタブの顧客データを読み込めません。上書きせず操作を停止しています。");
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!loaded || !reservations.ready) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const next = associateCustomers(recordsRef.current, [...reservations.reservations, ...reservations.trash], new Date().toISOString());
      if (next === recordsRef.current) return;
      try {
        if (!isCustomerCollection(next)) throw new Error("Conflicting associations");
        storageSnapshot.current = writeSnapshot(localStorage, storageKey, storageSnapshot.current, next);
        recordsRef.current = next;
        setRecords(next);
      } catch (error) { setNotice(error instanceof StorageConflictError ? error.message : "予約からの顧客情報を保存できませんでした。既存の予約データは変更していません。"); }
    });
    return () => { active = false; };
  }, [loaded, reservations.ready, reservations.reservations, reservations.trash]);
  const ready = loaded && reservations.ready;
  function persist(next: Customer[], message: string) {
    try {
      if (!isCustomerCollection(next)) throw new Error("Conflicting customer data");
      storageSnapshot.current = writeSnapshot(localStorage, storageKey, storageSnapshot.current, next);
      recordsRef.current = next;
      setRecords(next);
      setNotice(message);
      return true;
    } catch (error) { setNotice(error instanceof StorageConflictError ? error.message : "顧客データを保存できなかったため、変更は適用されていません。"); return false; }
  }
  function saveCustomer(draft: Draft, original?: Customer | null) {
    if (!ready) return "保存データを確認できるまで操作できません。";
    const name = draft.name.trim(), phone = draft.phone.normalize("NFKC").trim(), normalized = normalizePhone(phone);
    if (!name || name.length > 60 || !validPhone(phone) || draft.notes.length > 2000) return "顧客名（60文字以内）と有効な電話番号（数字10〜15桁）、メモ（2000文字以内）を入力してください。";
    const current = recordsRef.current;
    if (original && !sameCustomerDetails(current.find((item) => item.id === original.id), original)) return "この顧客は別の操作で変更・削除されました。入力内容を控えて最新の顧客を開き直してください。";
    if (current.some((item) => !item.deletedAt && item.id !== draft.id && (normalizePhone(item.phone) === normalized || item.phoneAliases.includes(normalized)))) return "この電話番号の顧客はすでに登録されています。";
    const previous = draft.id ? current.find((item) => item.id === draft.id && !item.deletedAt) : current.find((item) => item.deletedAt && (normalizePhone(item.phone) === normalized || item.phoneAliases.includes(normalized)));
    if (draft.id && !previous) return "この顧客は削除されているため編集できません。";
    if (current.some((item) => item.id !== previous?.id && item.deletedAt && (normalizePhone(item.phone) === normalized || item.phoneAliases.includes(normalized))) && draft.id) return "この電話番号は別の顧客の履歴に関連付いています。";
    const customer: Customer = { ...previous, id: previous?.id ?? crypto.randomUUID(), name, phone, notes: draft.notes.trim(), createdAt: previous?.createdAt ?? new Date().toISOString(), phoneAliases: [...new Set([...(previous?.phoneAliases ?? []), normalized])], reservationIds: previous?.reservationIds ?? [] };
    delete customer.deletedAt;
    const next = previous ? current.map((item) => item.id === previous.id ? customer : item) : [...current, customer];
    const associated = associateCustomers(next, [...reservations.reservations, ...reservations.trash], new Date().toISOString());
    return persist(associated, draft.id ? "顧客情報を更新しました。予約履歴は変更していません。" : "顧客を登録しました。") ? null : "保存できませんでした。入力内容は保持しています。";
  }
  function deleteCustomer(id: string, original?: Customer) {
    if (!ready) return false;
    const current = recordsRef.current;
    if (original && !sameCustomerDetails(current.find((item) => item.id === id), original)) { setNotice("この顧客は変更・削除されています。最新の内容をご確認ください。"); return false; }
    if (!current.some((item) => item.id === id && !item.deletedAt)) return false;
    return persist(current.map((item) => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item), "顧客を削除しました。予約・来店履歴・予約のゴミ箱は保持しています。");
  }
  return <CustomerContext.Provider value={{ customers: records.filter((item) => !item.deletedAt), ready, notice: notice || (!reservations.ready ? reservations.notice : ""), saveCustomer, deleteCustomer }}>{children}</CustomerContext.Provider>;
}

function sameCustomerDetails(a: Customer | undefined, b: Customer) {
  if (!a) return false;
  const details = (item: Customer) => ({ id: item.id, name: item.name, phone: item.phone, notes: item.notes, createdAt: item.createdAt, deletedAt: item.deletedAt });
  return sameRecord(details(a), details(b));
}

export function useCustomers() {
  const store = useContext(CustomerContext);
  if (!store) throw new Error("CustomerProvider is required");
  return store;
}
