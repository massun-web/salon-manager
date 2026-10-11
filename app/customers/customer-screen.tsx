"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Sidebar } from "../components/sidebar";
import { useReservations, type Reservation } from "../salon-manager";
import { useCustomers } from "./customer-store";
import { customerHistory, normalizePhone, type Customer } from "./customer-data";

function registrationLabel(value: string) {
  return new Date(value).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
}

function HistoryTable({ history }: { history: Reservation[] }) {
  if (history.length === 0) return <div className="empty-state"><h3>該当する履歴がありません</h3><p>この顧客に関連付いた予約がここに表示されます。</p></div>;
  return <div className="table-wrap"><table><thead><tr><th scope="col">予約日時</th><th scope="col">予約時の顧客情報</th><th scope="col">メニュー</th><th scope="col">担当スタッフ</th><th scope="col">ステータス</th><th scope="col">記録</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}>
    <td data-label="予約日時"><div className="reservation-time">{item.time}</div><span className="cell-secondary">{item.date}</span></td>
    <td data-label="予約時の顧客情報"><strong>{item.name}</strong><span className="cell-secondary phone">{item.phone}</span></td>
    <td data-label="メニュー">{item.menu}</td><td data-label="担当スタッフ">{item.staff}</td>
    <td data-label="ステータス"><span className={`badge ${item.status === "来店済み" ? "completed" : item.status === "キャンセル" ? "cancelled" : "confirmed"}`}>{item.status}</span></td>
    <td data-label="記録">{item.deletedAt ? <Link href="/trash" className="text-link">予約のゴミ箱</Link> : item.status === "来店済み" ? <span className="badge completed">来店履歴</span> : <span className="cell-secondary">予約履歴</span>}</td>
  </tr>)}</tbody></table></div>;
}

export function CustomerScreen({ customerId }: { customerId?: string }) {
  const store = useCustomers();
  const reservationStore = useReservations();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const formDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const customer = store.customers.find((item) => item.id === customerId);
  const allReservations = [...reservationStore.reservations, ...reservationStore.trash];
  const history = customer ? customerHistory(customer, allReservations) : [];
  const visits = history.filter((item) => item.status === "来店済み" && !item.deletedAt);
  const shownHistory = historyFilter === "visits" ? visits : history;
  const search = query.normalize("NFKC").trim().toLowerCase();
  const phoneSearch = normalizePhone(search);
  const filtered = store.customers.filter((item) => !search || item.name.normalize("NFKC").toLowerCase().includes(search) || item.phone.includes(search) || (phoneSearch.length > 0 && normalizePhone(item.phone).includes(phoneSearch))).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  function openForm(item: Customer | null) {
    setEditing(item); setError(""); setFormVersion((value) => value + 1); formDialog.current?.showModal();
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = store.saveCustomer({ id: editing?.id, name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? ""), notes: String(data.get("notes") ?? "") }, editing);
    if (result) { setError(result); return; }
    formDialog.current?.close();
  }
  function requestDelete(item: Customer) { setDeleting(item); setDeleteError(""); deleteDialog.current?.showModal(); }
  function confirmDelete() {
    if (!deleting) return;
    if (!store.deleteCustomer(deleting.id, deleting)) { setDeleteError("削除できませんでした。保存設定や別タブの変更をご確認ください。顧客データは消去していません。"); return; }
    deleteDialog.current?.close();
    if (customerId) router.replace("/customers");
  }
  return <div className="app-shell">
    <Sidebar section="customers" trashCount={reservationStore.trash.length} />
    <div className="workspace">
      <header className="topbar"><div><span className="breadcrumb">ワークスペース</span><span className="breadcrumb-separator">/</span><Link href="/customers">顧客管理</Link>{customerId && <><span className="breadcrumb-separator">/</span>顧客詳細</>}</div><span className="demo-label">DEMO</span></header>
      <main id="main-content" tabIndex={-1} className="main-content customers-content">
        {customerId && <Link href="/customers" className="text-link back-link">← 顧客一覧に戻る</Link>}
        <div className="page-heading"><div><p className="eyebrow">CUSTOMERS</p><h1>{customerId ? "顧客詳細" : "顧客管理"}</h1><p className="page-description">{customerId ? "お客様の情報と、これまでの来店を確認。" : "お客様の情報を、次の心地よい接客につなげる。"}</p></div>{!customerId && <button className="button primary" disabled={!store.ready} onClick={() => openForm(null)}>＋ 新規顧客</button>}</div>
        <p className="demo-reminder">公開デモです。実際の個人情報は入力しないでください。</p>
        <div role="status" aria-live="polite" className={store.notice ? "notice" : "notice empty-notice"}>{store.notice}</div>
        {!store.ready ? <section className="panel empty-state">{store.notice ? "保存データを確認できないため、顧客操作を停止しています。" : "顧客データを確認しています…"}</section> : customerId ? customer ? <>
          <section className="panel customer-profile">
            <div className="customer-profile-heading"><div className="customer-profile-name"><span className="team-avatar tone-0">{customer.name.slice(0, 1)}</span><div><h2>{customer.name}</h2><p>顧客情報</p></div></div><div className="customer-profile-actions"><button className="button secondary" onClick={() => openForm(customer)}>編集</button><button className="button secondary customer-delete" onClick={() => requestDelete(customer)}>削除</button></div></div>
            <dl className="customer-info"><div><dt>電話番号</dt><dd>{customer.phone}</dd></div><div><dt>登録日</dt><dd>{registrationLabel(customer.createdAt)}</dd></div><div><dt>来店回数</dt><dd>{visits.length}回</dd></div><div className="full-width"><dt>メモ</dt><dd className="customer-notes">{customer.notes || "メモは登録されていません。"}</dd></div></dl>
          </section>
          <section className="panel customer-history"><div className="panel-heading"><div><h2>予約・来店履歴<span className="count">{shownHistory.length}件</span></h2><p>顧客情報を変更しても、予約時の内容はそのまま保持されます。</p></div></div><div className="history-tabs" role="group" aria-label="履歴の絞り込み"><button className={historyFilter === "all" ? "active" : ""} aria-pressed={historyFilter === "all"} onClick={() => setHistoryFilter("all")}>すべての予約 ({history.length})</button><button className={historyFilter === "visits" ? "active" : ""} aria-pressed={historyFilter === "visits"} onClick={() => setHistoryFilter("visits")}>来店履歴 ({visits.length})</button></div><HistoryTable history={shownHistory} /><div className="panel-footer"><span>来店履歴：来店済みの予約（ゴミ箱内を除く）</span><span>完全削除済みの予約は表示されません</span></div></section>
        </> : <section className="panel empty-state"><h2>顧客が見つかりません</h2><p>削除された顧客、または存在しないページです。</p><Link className="button secondary" href="/customers">顧客一覧へ</Link></section> : <section className="panel customers-panel">
          <div className="panel-heading"><div><h2>顧客一覧<span className="count">{filtered.length}名</span></h2><p>顧客名・電話番号から、お客様をすばやく検索。</p></div></div>
          <div className="filters"><label className="search-field"><span aria-hidden="true">⌕</span><input type="search" aria-label="顧客を検索" placeholder="顧客名・電話番号で検索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{query && <button className="reset-button" onClick={() => setQuery("")}>クリア</button>}</div>
          {filtered.length === 0 ? <div className="empty-state"><h3>{query ? "該当する顧客が見つかりません" : "顧客が登録されていません"}</h3><p>{query ? "検索条件を変更してください。" : "「新規顧客」から登録できます。"}</p></div> : <div className="table-wrap"><table><thead><tr><th scope="col">顧客名</th><th scope="col">電話番号</th><th scope="col">来店回数</th><th scope="col">最終来店日</th><th scope="col">登録日</th><th scope="col">操作</th></tr></thead><tbody>{filtered.map((item) => {
            const visits = customerHistory(item, allReservations).filter((reservation) => reservation.status === "来店済み" && !reservation.deletedAt);
            return <tr key={item.id}><td data-label="顧客名"><Link href={`/customers/${encodeURIComponent(item.id)}`} className="customer-detail-link"><span className="customer-avatar">{item.name.slice(0, 1)}</span><strong>{item.name}</strong></Link></td><td data-label="電話番号">{item.phone}</td><td data-label="来店回数">{visits.length}回</td><td data-label="最終来店日">{visits[0]?.date ?? "来店履歴なし"}</td><td data-label="登録日">{registrationLabel(item.createdAt)}</td><td data-label="操作"><div className="row-actions"><Link href={`/customers/${encodeURIComponent(item.id)}`} className="text-link" aria-label={`${item.name}様の顧客詳細`}>詳細</Link><button onClick={() => openForm(item)} aria-label={`${item.name}様の顧客情報を編集`}>編集</button><button className="delete-button" onClick={() => requestDelete(item)} aria-label={`${item.name}様の顧客情報を削除`}>削除</button></div></td></tr>;
          })}</tbody></table></div>}
          <div className="panel-footer"><span>顧客情報はこのブラウザに保存されます</span><span>架空のサンプルデータ</span></div>
        </section>}
        <footer className="workspace-footer">Salon Manager<span>ポートフォリオ用デモ · 架空のサンプルデータ</span></footer>
      </main>
    </div>
    <dialog ref={formDialog} className="modal" aria-labelledby="customer-form-title"><div className="modal-heading"><div><p className="eyebrow">CUSTOMER</p><h2 id="customer-form-title">{editing ? "顧客情報を編集" : "新規顧客の登録"}</h2></div><button className="close-button" onClick={() => formDialog.current?.close()} aria-label="閉じる">×</button></div><form key={formVersion} onSubmit={submit} className="reservation-form"><p className="form-description">顧客名・電話番号は必須です。架空の情報でお試しください。</p><div className="form-grid"><label>顧客名<input name="name" defaultValue={editing?.name ?? ""} placeholder="例：サンプル 花子" required maxLength={60} autoFocus /></label><label>電話番号<input name="phone" type="tel" defaultValue={editing?.phone ?? ""} placeholder="例：090-0000-0000" required maxLength={24} /></label><label className="full-width">メモ<textarea name="notes" defaultValue={editing?.notes ?? ""} placeholder="好みのスタイルや接客時のメモ" maxLength={2000} rows={5} /></label></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={() => formDialog.current?.close()}>キャンセル</button><button type="submit" className="button primary">{editing ? "変更を保存" : "顧客を登録"}</button></div></form></dialog>
    <dialog ref={deleteDialog} className="modal delete-modal" aria-labelledby="customer-delete-title"><div className="modal-heading"><h2 id="customer-delete-title">顧客を削除しますか？</h2><button className="close-button" onClick={() => deleteDialog.current?.close()} aria-label="閉じる">×</button></div><div className="delete-content"><p><strong>{deleting?.name} 様</strong><br />{deleting?.phone}</p><p className="subtle">顧客一覧から削除します。予約・来店履歴・予約のゴミ箱は削除されません。予約データに残る関連付けを保持するため、削除済みの顧客は自動再登録されません。</p>{deleteError && <p role="alert" className="form-error">{deleteError}</p>}</div><div className="modal-footer"><button className="button secondary" onClick={() => deleteDialog.current?.close()}>戻る</button><button className="button danger" onClick={confirmDelete}>顧客を削除する</button></div></dialog>
  </div>;
}
