import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Run pure TypeScript rules without a browser, network, or application storage.
function load(path, dependencies = {}) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = createContext({ exports, crypto: globalThis.crypto, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected runtime import: ${name}`);
    return dependencies[name];
  } });
  new Script(compiled, { filename: path }).runInContext(context);
  return exports;
}
const safety = load("app/lib/data-safety.ts");
const demo = load("app/lib/demo-reset.ts", { "./data-safety": safety });
test("demo reset is scoped, rejects stale confirmation and rolls back failed second write", () => {
  const values = new Map([[demo.demoKeys[0], "old-reservations"], [demo.demoKeys[1], "old-customers"], ["unrelated", "keep"]]);
  let fail = false;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (fail && key === demo.demoKeys[1]) throw new Error("quota"); values.set(key, value); }, removeItem: key => values.delete(key) };
  const original = demo.captureDemo(storage);
  fail = true;
  assert.throws(() => demo.resetDemo(storage, original, [], []), /quota/);
  assert.equal(values.get(demo.demoKeys[0]), "old-reservations");
  assert.equal(values.get(demo.demoKeys[1]), "old-customers");
  values.set(demo.demoKeys[1], "other-tab");
  assert.throws(() => demo.resetDemo(storage, original, [], []), /別のタブ/);
  assert.equal(values.get(demo.demoKeys[0]), "old-reservations");
  fail = false;
  demo.resetDemo(storage, demo.captureDemo(storage), [{ id: "sample" }], []);
  assert.equal(values.get(demo.demoKeys[0]), '[{"id":"sample"}]');
  assert.equal(values.get(demo.demoKeys[1]), "[]");
  assert.equal(values.get("unrelated"), "keep");
  values.delete(demo.demoKeys[0]); fail = true;
  assert.throws(() => demo.resetDemo(storage, demo.captureDemo(storage), [], []), /quota/);
  assert.equal(values.has(demo.demoKeys[0]), false);
});
const customers = load("app/customers/customer-data.ts", { "../lib/data-safety": safety });
const rules = load("app/lib/reservation-rules.ts");
const reservation = { id: "legacy-1", name: "架空 顧客", phone: "090-0000-0000", date: "2026-10-11", time: "10:00", menu: "カット", staff: "佐藤 美咲", status: "来店済み" };
const registeredAt = "2026-10-11T00:00:00.000Z";

test("phone normalization agrees for spacing, full-width and +81", () => {
  for (const phone of ["090-0000-0000", "０９０－００００－００００", "090 0000 0000", "+81 90 0000 0000"]) assert.equal(customers.normalizePhone(phone), "09000000000");
  assert.equal(customers.validPhone("090abc00000000"), false);
  assert.equal(customers.validPhone("123"), false);
});
test("legacy customer association never mutates reservation or input customers", () => {
  const original = JSON.stringify(reservation);
  const result = customers.associateCustomers([], [reservation, { ...reservation, id: "legacy-2", phone: "+81 90 0000 0000" }], registeredAt);
  assert.equal(result.length, 1);
  assert.equal(result[0].reservationIds.length, 2);
  assert.equal(JSON.stringify(reservation), original);
  assert.equal(customers.isCustomerCollection(result), true);
  assert.equal(customers.associateCustomers(result, [reservation], registeredAt), result);
});
test("customer edits retain stable history links even if reservation phone changes", () => {
  const initial = customers.associateCustomers([], [reservation], registeredAt);
  const edited = [{ ...initial[0], name: "架空 変更", phone: "080-0000-0000", phoneAliases: ["09000000000", "08000000000"] }];
  const next = customers.associateCustomers(edited, [{ ...reservation, phone: "070-0000-0000" }], registeredAt);
  assert.equal(next.length, 1);
  assert.equal(customers.customerHistory(next[0], [reservation]).length, 1);
  assert.equal(next[0].name, "架空 変更");
});
test("deleted customer is not recreated; booking history survives customer deletion", () => {
  const original = customers.associateCustomers([], [reservation], registeredAt);
  const deleted = [{ ...original[0], deletedAt: registeredAt }];
  assert.equal(customers.associateCustomers(deleted, [reservation], registeredAt), deleted);
  assert.equal(customers.customerHistory(deleted[0], [reservation]).length, 1);
});
test("ambiguous IDs, phone aliases and history ownership are rejected without repair", () => {
  const initial = customers.associateCustomers([], [reservation], registeredAt);
  assert.equal(customers.isCustomerCollection([initial[0], { ...initial[0], id: "other" }]), false);
  assert.equal(customers.isCustomerCollection([initial[0], { ...initial[0], id: "other", phone: "080-0000-0000", phoneAliases: ["08000000000"] }]), false);
  assert.equal(safety.uniqueIds([{ id: "same" }, { id: "same" }]), false);
  assert.equal(safety.uniqueIds([{ id: " " }]), false);
  assert.equal(customers.isCustomerCollection([]), true);
});
test("trash retention is exactly 72 hours; active reservation never expires", () => {
  const deleted = { ...reservation, deletedAt: registeredAt };
  const boundary = Date.parse(registeredAt) + 72 * 3600000;
  assert.equal(rules.expired(deleted, boundary - 1), false);
  assert.equal(rules.expired(deleted, boundary), true);
  assert.equal(rules.expired(deleted, boundary + 1), true);
  assert.equal(rules.expired(reservation, boundary + 1), false);
});
test("start-time conflicts exclude self, cancellation and trash; distinguish dates and staff", () => {
  assert.equal(rules.hasReservationConflict(reservation, [{ ...reservation, id: "other" }]), true);
  for (const other of [reservation, { ...reservation, id: "other", status: "キャンセル" }, { ...reservation, id: "other", deletedAt: registeredAt }, { ...reservation, id: "other", staff: "別のスタッフ" }, { ...reservation, id: "other", date: "2026-10-12" }]) assert.equal(rules.hasReservationConflict(reservation, [other]), false);
  assert.equal(rules.hasReservationConflict({ ...reservation, status: "キャンセル" }, [{ ...reservation, id: "other" }]), false);
});
test("snapshot write refuses stale data and leaves newest data intact", () => {
  let value = "newest";
  const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  assert.throws(() => safety.writeSnapshot(storage, "demo", "stale", [reservation]), safety.StorageConflictError);
  assert.equal(value, "newest");
  assert.equal(safety.writeSnapshot(storage, "demo", "newest", []), "[]");
  assert.equal(value, "[]");
});
test("storage failure cannot change the saved snapshot", () => {
  const storage = { getItem: () => "old", setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.throws(() => safety.writeSnapshot(storage, "demo", "old", [reservation]), /QuotaExceededError/);
  assert.equal(storage.getItem(), "old");
});
