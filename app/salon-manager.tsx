"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sidebar } from "./components/sidebar";
import { StorageConflictError, sameRecord, uniqueIds, writeSnapshot } from "./lib/data-safety";
import { validPhone, normalizePhone } from "./customers/customer-data";
import { expired, retentionMs, hasReservationConflict } from "./lib/reservation-rules";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
const statuses = ["予約確定", "来店済み", "キャンセル"] as const;
type Status = (typeof statuses)[number];
export type Reservation = {
    id: string;
    name: string;
    phone: string;
    date: string;
    time: string;
    menu: string;
    staff: string;
    status: Status;
    deletedAt?: string;
};
const menus = ["カット", "カット + カラー", "カット + パーマ", "カラー", "トリートメント", "ヘッドスパ"];
const staffMembers = ["佐藤 美咲", "田中 健太", "鈴木 結衣"];
const storageKey = "salon-manager-reservations-v1";
function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function shiftedDate(days: number) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localDate(date);
}
export function samples(): Reservation[] {
    return [
        { id: "sample-1", name: "山田 花子", phone: "090-1234-5678", date: localDate(), time: "09:30", menu: menus[0], staff: staffMembers[0], status: "来店済み" },
        { id: "sample-2", name: "高橋 彩香", phone: "080-2345-6789", date: localDate(), time: "10:30", menu: menus[1], staff: staffMembers[2], status: "来店済み" },
        { id: "sample-3", name: "伊藤 大輔", phone: "090-3456-7890", date: localDate(), time: "13:00", menu: menus[0], staff: staffMembers[1], status: "予約確定" },
        { id: "sample-4", name: "小林 美月", phone: "080-4567-8901", date: localDate(), time: "14:00", menu: menus[1], staff: staffMembers[0], status: "予約確定" },
        { id: "sample-5", name: "渡辺 直子", phone: "090-5678-9012", date: localDate(), time: "15:30", menu: menus[5], staff: staffMembers[2], status: "予約確定" },
        { id: "sample-6", name: "加藤 翔", phone: "080-6789-0123", date: localDate(), time: "16:00", menu: menus[2], staff: staffMembers[1], status: "キャンセル" },
        { id: "sample-7", name: "中村 優子", phone: "090-7890-1234", date: shiftedDate(1), time: "11:00", menu: menus[4], staff: staffMembers[0], status: "予約確定" },
        { id: "sample-8", name: "松本 亮", phone: "080-8901-2345", date: shiftedDate(2), time: "13:30", menu: menus[0], staff: staffMembers[1], status: "予約確定" },
    ];
}
function isReservation(value: unknown): value is Reservation {
    if (!value || typeof value !== "object")
        return false;
    const item = value as Record<string, unknown>;
    const date = new Date(`${String(item.date)}T12:00:00`);
    return ["id", "name", "phone", "date", "time", "menu", "staff"].every((key) => typeof item[key] === "string") &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(item.date)) && /^\d{2}:\d{2}$/.test(String(item.time)) &&
        !Number.isNaN(date.getTime()) && localDate(date) === item.date && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(item.time)) &&
        (item.deletedAt === undefined || (typeof item.deletedAt === "string" && Number.isFinite(Date.parse(item.deletedAt)))) &&
        statuses.includes(item.status as Status) && menus.includes(String(item.menu)) && staffMembers.includes(String(item.staff));
}
export function isReservationCollection(value: unknown): value is Reservation[] {
    return Array.isArray(value) && value.every(isReservation) && uniqueIds(value);
}
type Store = {
    reservations: Reservation[];
    trash: Reservation[];
    now: number;
    ready: boolean;
    today: string;
    save: (item: Reservation, original?: Reservation | null) => string | null;
    remove: (id: string, original?: Reservation) => boolean;
    restore: (id: string) => void;
    permanentlyRemove: (id: string, original?: Reservation) => boolean;
    notice: string;
};
const ReservationContext = createContext<Store | null>(null);
export function useReservations() {
    const store = useContext(ReservationContext);
    if (!store) throw new Error("ReservationProvider is required");
    return store;
}
export function ReservationProvider({ children }: {
    children: ReactNode;
}) {
    const [records, setRecords] = useState<Reservation[]>([]);
    const recordsRef = useRef<Reservation[]>([]);
    const storageSnapshot = useRef<string | null>(null);
    const [now, setNow] = useState(0);
    const [ready, setReady] = useState(false);
    const [today, setToday] = useState("");
    const [notice, setNotice] = useState("");
    const pathname = usePathname();
    const persist = useCallback((next: Reservation[], message?: string) => {
        try {
            // Active and deleted records are stored together in one atomic write.
            storageSnapshot.current = writeSnapshot(localStorage, storageKey, storageSnapshot.current, next);
            recordsRef.current = next;
            setRecords(next);
            if (message) setNotice(message);
            return true;
        } catch (error) {
            setNotice(error instanceof StorageConflictError ? error.message : "保存できなかったため、変更は適用されていません。ブラウザの保存設定や空き容量をご確認ください。");
            return false;
        }
    }, []);
    const prune = useCallback(() => {
        const currentTime = Date.now();
        setNow(currentTime);
        setToday(localDate());
        const next = recordsRef.current.filter((item) => !expired(item, currentTime));
        if (next.length !== recordsRef.current.length) persist(next);
    }, [persist]);
    useEffect(() => {
        let active = true;
        queueMicrotask(() => {
            if (!active)
                return;
            let initial: Reservation[];
            let storedRaw: string | null = null;
            try {
                const stored = localStorage.getItem(storageKey);
                storedRaw = stored;
                if (stored === null) initial = samples();
                else {
                    const parsed: unknown = JSON.parse(stored);
                    if (isReservationCollection(parsed))
                        initial = parsed;
                    else {
                        setNotice("保存データを読み込めませんでした。既存データ保護のため、上書きせず操作を停止しています。");
                        return;
                    }
                }
            }
            catch {
                setNotice("保存データを読み込めませんでした。既存データ保護のため、上書きせず操作を停止しています。");
                return;
            }
            storageSnapshot.current = storedRaw;
            recordsRef.current = initial;
            setRecords(initial);
            prune();
            setReady(true);
        });
        return () => { active = false; };
    }, [prune]);
    useEffect(() => {
        function sync(event: StorageEvent) {
            if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
            try {
                const raw = localStorage.getItem(storageKey);
                const parsed: unknown = raw === null ? [] : JSON.parse(raw);
                if (!isReservationCollection(parsed)) throw new Error("Invalid data");
                storageSnapshot.current = raw;
                recordsRef.current = parsed;
                setRecords(parsed);
                setReady(true);
                setNotice("別のタブの予約変更を反映しました。編集中の場合は最新の内容をご確認ください。");
                prune();
            } catch {
                setReady(false);
                setNotice("別のタブで予約データが変更されましたが、読み込めません。上書きせず操作を停止しています。");
            }
        }
        window.addEventListener("storage", sync);
        return () => window.removeEventListener("storage", sync);
    }, [prune]);
    useEffect(() => {
        if (!ready) return;
        let active = true;
        queueMicrotask(() => { if (active) prune(); });
        const timer = window.setInterval(prune, 1000);
        const onVisible = () => { if (document.visibilityState === "visible") prune(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
    }, [ready, pathname, prune]);
    function save(item: Reservation, original?: Reservation | null) {
        if (!ready) return "保存データを確認できるまで操作できません。";
        if (!isReservation(item) || !item.name.trim() || item.name.length > 60 || !validPhone(item.phone)) return "顧客名・電話番号・日時・メニュー・担当スタッフを確認してください。";
        const current = recordsRef.current.filter((entry) => !expired(entry, Date.now()));
        const previous = current.find((entry) => entry.id === item.id);
        if (original && (!previous || previous.deletedAt || !sameRecord(previous, original))) return "この予約は別の操作で変更・削除されました。入力内容を控えて最新の予約を開き直してください。";
        if (!original && previous) return "同じIDの予約が存在します。最新の内容をご確認ください。";
        if (hasReservationConflict(item, current)) return "同じ日時・担当スタッフの予約がすでにあります。";
        return persist(previous ? current.map((entry) => entry.id === item.id ? { ...entry, ...item } : entry) : [...current, item], previous ? "予約を更新しました。" : "予約を登録しました。") ? null : "保存できませんでした。入力内容は保持しています。別タブの変更や保存設定をご確認ください。";
    }
    function remove(id: string, original?: Reservation) {
        if (!ready) return false;
        const currentTime = Date.now();
        setNow(currentTime);
        const current = recordsRef.current.filter((item) => !expired(item, currentTime));
        const item = current.find((item) => item.id === id && !item.deletedAt);
        if (!item || (original && !sameRecord(item, original))) { setNotice("この予約は変更・削除されています。確認画面を閉じて最新の内容をご確認ください。"); return false; }
        return persist(current.map((item) => item.id === id && !item.deletedAt ? { ...item, deletedAt: new Date(currentTime).toISOString() } : item), "予約をゴミ箱に移動しました。削除日時から72時間以内は復元できます。");
    }
    function restore(id: string) {
        if (!ready) return;
        const item = recordsRef.current.find((entry) => entry.id === id && entry.deletedAt);
        if (!item) return;
        if (expired(item, Date.now())) { prune(); setNotice("復元期限の72時間が過ぎたため、この予約は復元できません。"); return; }
        if (hasReservationConflict(item, recordsRef.current)) {
            setNotice("同じ日時・担当スタッフの予約があるため復元できません。既存の予約を編集してから、もう一度復元してください。");
            return;
        }
        const restored = { ...item };
        delete restored.deletedAt;
        persist(recordsRef.current.filter((entry) => !expired(entry, Date.now())).map((entry) => entry.id === id ? restored : entry), "予約を復元しました。予約一覧で確認できます。");
    }
    function permanentlyRemove(id: string, original?: Reservation) {
        const item = recordsRef.current.find((item) => item.id === id && item.deletedAt);
        if (!ready || !item || (original && !sameRecord(item, original))) { setNotice("この予約は変更・削除されています。最新の内容をご確認ください。"); return false; }
        return persist(recordsRef.current.filter((item) => !(item.id === id && item.deletedAt) && !expired(item, Date.now())), "予約を完全削除しました。");
    }
    const reservations = records.filter((item) => !item.deletedAt);
    const trash = records.filter((item) => item.deletedAt && !expired(item, now));
    return <ReservationContext.Provider value={{ reservations, trash, now, ready, today, save, remove, restore, permanentlyRemove, notice }}>{children}</ReservationContext.Provider>;
}
function deletionDateLabel(value: string) {
    return new Date(value).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function remainingLabel(deletedAt: string, now: number) {
    const minutes = Math.max(0, Math.ceil((Date.parse(deletedAt) + retentionMs - now) / 60000));
    return minutes > 0 ? `あと${Math.floor(minutes / 60)}時間${minutes % 60}分` : "期限切れ";
}
function Icon({ name }: {
    name: "grid" | "calendar" | "plus" | "search" | "arrow" | "check" | "clock" | "users" | "trash";
}) {
    const paths = {
        trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
        grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
        calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/></>,
        plus: <path d="M12 5v14M5 12h14"/>,
        search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
        arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
        check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
        clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
        users: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
    };
    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Badge({ status }: {
    status: Status;
}) {
    return <span className={`badge ${status === "来店済み" ? "completed" : status === "キャンセル" ? "cancelled" : "confirmed"}`}><span />{status}</span>;
}
function dateLabel(date: string) {
    return new Date(`${date}T12:00:00`).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
}
export function SalonScreen({ view }: {
    view: "dashboard" | "reservations" | "trash";
}) {
    const store = useContext(ReservationContext);
    if (!store)
        throw new Error("ReservationProvider is required");
    const { reservations, trash, now, ready, today, save, remove, restore, permanentlyRemove, notice } = store;
    const [query, setQuery] = useState("");
    const [dateFilter, setDateFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [editing, setEditing] = useState<Reservation | null>(null);
    const [deleting, setDeleting] = useState<Reservation | null>(null);
    const [error, setError] = useState("");
    const [deleteError, setDeleteError] = useState("");
    const [formVersion, setFormVersion] = useState(0);
    const formDialog = useRef<HTMLDialogElement>(null);
    const deleteDialog = useRef<HTMLDialogElement>(null);
    const dashboard = view === "dashboard";
    const isTrash = view === "trash";
    const pageTitle = dashboard ? "ダッシュボード" : isTrash ? "最近削除した予約" : "予約管理";
    const todays = reservations.filter((item) => item.date === today);
    const activeToday = todays.filter((item) => item.status !== "キャンセル");
    const completed = todays.filter((item) => item.status === "来店済み").length;
    const pending = todays.filter((item) => item.status === "予約確定").length;
    const search = query.normalize("NFKC").trim().toLowerCase();
    const phoneSearch = normalizePhone(search);
    const filtered = (dashboard ? todays : reservations).filter((item) => (!dateFilter || item.date === dateFilter) && (!statusFilter || item.status === statusFilter) &&
        (!search || [item.name, item.phone, item.menu, item.staff].some((value) => value.normalize("NFKC").toLowerCase().includes(search)) || (phoneSearch.length > 0 && normalizePhone(item.phone).includes(phoneSearch)))).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    function openForm(item: Reservation | null) { setEditing(item); setError(""); setFormVersion((version) => version + 1); formDialog.current?.showModal(); }
    function confirmDelete() {
        if (!deleting) return;
        if (!(isTrash ? permanentlyRemove : remove)(deleting.id, deleting)) {
            setDeleteError("削除できませんでした。保存設定や別タブの変更をご確認ください。予約データは消去していません。");
            return;
        }
        deleteDialog.current?.close();
    }
    function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const item: Reservation = {
            ...editing,
            id: editing?.id ?? crypto.randomUUID(), name: String(data.get("name") ?? "").trim(), phone: String(data.get("phone") ?? "").normalize("NFKC").trim(),
            date: String(data.get("date")), time: String(data.get("time")), menu: String(data.get("menu")), staff: String(data.get("staff")), status: String(data.get("status")) as Status,
        };
        if (!item.name || item.name.length > 60 || !validPhone(item.phone)) {
            setError("顧客名と有効な電話番号（数字10〜15桁）を入力してください。");
            return;
        }
        if (!isReservation(item) || Number.isNaN(new Date(`${item.date}T${item.time}`).getTime())) {
            setError("予約内容を確認してください。");
            return;
        }
        if (item.status !== "キャンセル" && reservations.some((other) => other.id !== item.id && other.date === item.date && other.time === item.time && other.staff === item.staff && other.status !== "キャンセル")) {
            setError("同じ日時・担当スタッフの予約がすでにあります。日時または担当スタッフを変更してください。");
            return;
        }
        const result = save(item, editing);
        if (result) { setError(result); return; }
        formDialog.current?.close();
    }
    return (<div className="app-shell">
      <Sidebar section={view} trashCount={trash.length} />
      <div className="workspace">
        <header className="topbar"><div><span className="breadcrumb">ワークスペース</span><span className="breadcrumb-separator">/</span><span>{pageTitle}</span></div><span className="demo-label">DEMO</span></header>
        <main id="main-content" tabIndex={-1} className="main-content">
          <div className="page-heading"><div><p className="eyebrow">{dashboard ? "OVERVIEW" : isTrash ? "RECENTLY DELETED" : "RESERVATIONS"}</p><h1>{pageTitle}</h1><p className="page-description">{dashboard ? "今日の予約と来店状況を、ひと目で確認。" : isTrash ? "削除日時から72時間以内の予約を復元できます。" : "予約の確認から登録まで、ここでまとめて管理。"}</p></div>{!isTrash && <button className="button primary" onClick={() => openForm(null)} disabled={!ready}><Icon name="plus"/>新規予約</button>}</div>
          <p className="demo-reminder">公開デモです。実際の個人情報は入力しないでください。</p>
          <div role="status" aria-live="polite" className={notice ? "notice" : "notice empty-notice"}>{notice}</div>
          {dashboard && <>
            <div className="date-heading"><span>{today ? dateLabel(today) : "読み込み中…"}</span><span className="subtle">今日のサロン</span></div>
            <section className="stats-grid" aria-label="今日の予約状況">
              {[{ label: "今日の予約", value: activeToday.length, icon: "calendar" as const, tone: "purple", detail: "キャンセルを除く予約数" }, { label: "来店済み", value: completed, icon: "check" as const, tone: "green", detail: "本日の来店完了" }, { label: "来店予定", value: pending, icon: "clock" as const, tone: "orange", detail: "予約確定・来店待ち" }].map((stat) => <article className="stat-card" key={stat.label}><div className="stat-top"><span>{stat.label}</span><span className={`stat-icon ${stat.tone}`}><Icon name={stat.icon}/></span></div><div className="stat-number">{ready ? stat.value : "—"}<span>件</span></div><p>{stat.detail}</p></article>)}
            </section>
          </>}
          {isTrash ? <section className="panel trash-panel">
            <div className="panel-heading"><div><h2>ゴミ箱<span className="count">{trash.length}件</span></h2><p>期限を過ぎた予約は自動的に完全削除されます。</p></div><Icon name="trash" /></div>
            {!ready ? <div className="empty-state">{notice ? "保存データを確認できないため、操作を停止しています。" : "データを読み込んでいます…"}</div> : trash.length === 0 ? <div className="empty-state"><Icon name="trash" /><h3>ゴミ箱は空です</h3><p>削除した予約はここに表示されます。</p></div> : <div className="table-wrap"><table><thead><tr><th scope="col">予約日時</th><th scope="col">顧客名</th><th scope="col">メニュー</th><th scope="col">削除日時</th><th scope="col">完全削除まで</th><th scope="col">操作</th></tr></thead><tbody>{[...trash].sort((a, b) => Date.parse(b.deletedAt!) - Date.parse(a.deletedAt!)).map((item) => <tr key={item.id}>
              <td data-label="予約日時"><div className="reservation-time">{item.time}</div><span className="cell-secondary">{item.date} · {dateLabel(item.date)}</span></td>
              <td data-label="顧客名"><strong>{item.name}</strong><span className="cell-secondary phone">{item.phone}</span></td>
              <td data-label="メニュー">{item.menu}</td>
              <td data-label="削除日時"><span className="trash-deleted-date">{deletionDateLabel(item.deletedAt!)}</span></td>
              <td data-label="完全削除まで"><span className={Date.parse(item.deletedAt!) + retentionMs - now < 3600000 ? "badge remaining urgent" : "badge remaining"}>{remainingLabel(item.deletedAt!, now)}</span></td>
              <td data-label="操作"><div className="row-actions"><button onClick={() => restore(item.id)} aria-label={item.name + "様の予約を復元"}>復元</button><button className="delete-button" onClick={() => { setDeleting(item); setDeleteError(""); deleteDialog.current?.showModal(); }} aria-label={item.name + "様の予約を完全削除"}>完全削除</button></div></td>
            </tr>)}</tbody></table></div>}
            <div className="panel-footer"><span>保存期間：削除日時から72時間</span><span>日時は端末の現地時間で表示</span></div>
          </section> : <>
          <section className="panel">
            <div className="panel-heading"><div><h2>{dashboard ? "今日の予約一覧" : "予約一覧"}<span className="count">{filtered.length}件</span></h2><p>{dashboard ? "本日の予約を時間順に表示しています。" : "顧客名・電話番号・メニュー・スタッフで検索できます。"}</p></div>{dashboard && <Link className="text-link" href="/reservations">すべての予約<Icon name="arrow"/></Link>}</div>
            <div className="filters"><label className="search-field"><Icon name="search"/><input aria-label="予約を検索" type="search" placeholder="顧客名・電話番号などで検索" value={query} onChange={(event) => setQuery(event.target.value)}/></label>{!dashboard && <label className="filter-label"><span>予約日</span><input aria-label="予約日で絞り込み" type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}/></label>}<label className="filter-label"><span>ステータス</span><select aria-label="ステータスで絞り込み" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">すべて</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>{(query || dateFilter || statusFilter) && <button className="reset-button" onClick={() => { setQuery(""); setDateFilter(""); setStatusFilter(""); }}>クリア</button>}</div>
            {!ready ? <div className="empty-state">{notice ? "保存データを確認できないため、予約操作を停止しています。" : "予約を読み込んでいます…"}</div> : filtered.length === 0 ? <div className="empty-state"><Icon name="calendar"/><h3>予約がありません</h3><p>{query || dateFilter || statusFilter ? "検索条件を変更して、もう一度お試しください。" : "「新規予約」から予約を登録できます。"}</p></div> : <div className="table-wrap"><table><thead><tr><th scope="col">日時</th><th scope="col">顧客</th><th scope="col">メニュー</th><th scope="col">担当スタッフ</th><th scope="col">ステータス</th><th scope="col" className="actions-heading">操作</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id} className={item.status === "キャンセル" ? "cancelled-row" : undefined}><td data-label="日時"><div className="reservation-time">{item.time}</div><span className="cell-secondary">{dateLabel(item.date)}</span></td><td data-label="顧客"><div className="customer-cell"><span className="customer-avatar">{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><span className="cell-secondary phone">{item.phone}</span></div></div></td><td data-label="メニュー">{item.menu}</td><td data-label="担当スタッフ"><span className="staff-dot"/>{item.staff}</td><td data-label="ステータス"><Badge status={item.status}/></td><td data-label="操作"><div className="row-actions"><button onClick={() => openForm(item)} aria-label={`${item.name}様 ${item.date} ${item.time}の予約を編集`}>編集</button><button className="delete-button" onClick={() => { setDeleting(item); setDeleteError(""); deleteDialog.current?.showModal(); }} aria-label={`${item.name}様 ${item.date} ${item.time}の予約を削除`}>削除</button></div></td></tr>)}</tbody></table></div>}
            <div className="panel-footer"><span>{dashboard ? "今日" : "検索条件に一致する予約"}：{filtered.length}件</span><span>時刻は端末の現地時間で表示</span></div>
          </section>
          </>}
          {dashboard && <section className="team-panel"><div className="team-heading"><span className="stat-icon purple"><Icon name="users"/></span><div><h2>今日のスタッフ</h2><p>担当ごとの予約状況</p></div></div><div className="team-grid">{staffMembers.map((staff, index) => { const assigned = activeToday.filter((item) => item.staff === staff); return <div className="team-member" key={staff}><span className={`team-avatar tone-${index}`}>{staff.slice(0, 1)}</span><div><strong>{staff}</strong><p>来店済み {assigned.filter((item) => item.status === "来店済み").length}件 / 予約 {assigned.length}件</p></div></div>; })}</div></section>}
          <footer className="workspace-footer">Salon Manager<span>ポートフォリオ用デモ · データはこのブラウザ内に保存</span></footer>
        </main>
      </div>
      <dialog ref={formDialog} className="modal" aria-labelledby="form-title">
        <div className="modal-heading"><div><p className="eyebrow">RESERVATION</p><h2 id="form-title">{editing ? "予約を編集" : "新規予約の登録"}</h2></div><button className="close-button" onClick={() => formDialog.current?.close()} aria-label="閉じる">×</button></div>
        <form key={formVersion} onSubmit={submit} className="reservation-form"><p className="form-description">お客様と予約内容を入力してください。すべて必須です。</p><div className="form-grid"><label>顧客名<input name="name" placeholder="例：山田 花子" defaultValue={editing?.name ?? ""} required maxLength={60} autoFocus/></label><label>電話番号<input name="phone" type="tel" placeholder="例：090-1234-5678" defaultValue={editing?.phone ?? ""} required maxLength={24}/></label><label>予約日<input name="date" type="date" defaultValue={editing?.date ?? (dateFilter || today)} required/></label><label>予約時間<input name="time" type="time" defaultValue={editing?.time ?? "10:00"} required/></label><label>メニュー<select name="menu" defaultValue={editing?.menu ?? menus[0]}>{menus.map((menu) => <option key={menu}>{menu}</option>)}</select></label><label>担当スタッフ<select name="staff" defaultValue={editing?.staff ?? staffMembers[0]}>{staffMembers.map((staff) => <option key={staff}>{staff}</option>)}</select></label><label className="full-width">ステータス<select name="status" defaultValue={editing?.status ?? "予約確定"}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" onClick={() => formDialog.current?.close()}>キャンセル</button><button type="submit" className="button primary">{editing ? "変更を保存" : "予約を登録"}</button></div></form>
      </dialog>
      <dialog ref={deleteDialog} className="modal delete-modal" aria-labelledby="delete-title"><div className="modal-heading"><h2 id="delete-title">{isTrash ? "予約を完全削除しますか？" : "予約を削除しますか？"}</h2><button className="close-button" onClick={() => deleteDialog.current?.close()} aria-label="閉じる">×</button></div><div className="delete-content"><p><strong>{deleting?.name} 様</strong><br />{deleting && `${dateLabel(deleting.date)} ${deleting.time} · ${deleting.menu}`}</p><p className="subtle">{isTrash ? "完全削除した予約は復元できません。この操作は取り消せません。" : "予約をゴミ箱に移動します。削除日時から72時間以内は「最近削除した予約」から復元できます。"}</p>{deleteError && <p role="alert" className="form-error">{deleteError}</p>}</div><div className="modal-footer"><button className="button secondary" onClick={() => deleteDialog.current?.close()}>戻る</button><button className="button danger" onClick={confirmDelete}>{isTrash ? "完全削除する" : "削除する"}</button></div></dialog>
    </div>);
}
