import Link from "next/link";

type Section = "dashboard" | "reservations" | "customers" | "trash";
const links: { section: Section; href: string; label: string; path: string }[] = [
  { section: "dashboard", href: "/", label: "ダッシュボード", path: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" },
  { section: "reservations", href: "/reservations", label: "予約管理", path: "M3 5h18v16H3zM7 3v4M17 3v4M3 11h18" },
  { section: "customers", href: "/customers", label: "顧客管理", path: "M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" },
  { section: "trash", href: "/trash", label: "最近削除した予約", path: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" },
];

export function Sidebar({ section, trashCount }: { section: Section; trashCount: number }) {
  return <aside className="sidebar">
    <Link href="/" className="brand"><span className="brand-mark">s<span>.</span></span><span>Salon Manager<small>サロンの毎日を、シンプルに。</small></span></Link>
    <p className="nav-label">ワークスペース</p>
    <nav aria-label="メインナビゲーション">{links.map((link) => <Link key={link.section} href={link.href} className={section === link.section ? "nav-link selected" : "nav-link"} aria-current={section === link.section ? "page" : undefined}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={link.path} /></svg>
      {link.label}{link.section === "trash" && <span className="trash-nav-count">{trashCount}</span>}
    </Link>)}</nav>
    <div className="sidebar-note"><span className="demo-dot" />デモワークスペース<p>架空のサンプルデータで操作できます。<br />実際の個人情報は入力しないでください。<br />変更はこのブラウザに保存されます。</p></div>
    <div className="sidebar-profile"><span className="avatar">S</span><div>Salon sample<small>スタッフ用ワークスペース</small></div></div>
  </aside>;
}
