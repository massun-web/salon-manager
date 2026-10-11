"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ReservationProvider, samples } from "../salon-manager";
import { CustomerProvider } from "../customers/customer-store";
import { associateCustomers } from "../customers/customer-data";
import { captureDemo, resetDemo } from "../lib/demo-reset";
import { StorageConflictError } from "../lib/data-safety";

export function DemoWorkspace({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const snapshot = useRef<(string | null)[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  function openReset() {
    setError("");
    try { snapshot.current = captureDemo(localStorage); }
    catch { setMessage("保存データを確認できません。ブラウザの保存設定を確認してください。"); return; }
    dialog.current?.showModal();
  }
  function confirmReset() {
    try {
      const reservations = samples();
      const customers = associateCustomers([], reservations, new Date().toISOString());
      resetDemo(localStorage, snapshot.current, reservations, customers);
      dialog.current?.close();
      setGeneration(value => value + 1);
      router.replace("/");
      setMessage("デモデータを初期状態に戻しました。8件のサンプル予約と顧客を表示します。");
    } catch (cause) {
      setError(cause instanceof StorageConflictError ? "確認中に保存データが変更されました。キャンセルして、内容を確認してからやり直してください。" : cause instanceof Error && cause.message.includes("保存状態") ? cause.message : "リセットできませんでした。保存設定や空き容量を確認してください。変更前のデータを保持しています。");
    }
  }
  return <>
    <aside className="demo-banner" aria-label="ポートフォリオ用デモの案内">
      <div><strong>ポートフォリオ用デモ</strong><p>このアプリはポートフォリオ用のデモです。架空の顧客データを使用しています。入力内容はお使いのブラウザ内に保存され、他の端末とは共有されません。実際の個人情報は入力しないでください。</p></div>
      <button type="button" className="button secondary" onClick={openReset}>デモデータをリセット</button>
      {message && <p className="demo-result" role="status">{message}</p>}
    </aside>
    <ReservationProvider key={generation}><CustomerProvider>{children}</CustomerProvider></ReservationProvider>
    <dialog ref={dialog} className="modal" aria-labelledby="demo-reset-title">
      <div className="demo-reset-content"><h2 id="demo-reset-title">デモデータをリセットしますか？</h2>
        <p>このブラウザに保存した次のデータを削除し、初期サンプルに戻します。この操作は取り消せません。</p>
        <ul><li>登録・編集した予約と予約ステータス</li><li>顧客情報、電話番号、メモ、予約履歴の関連付け</li><li>ゴミ箱の予約と削除済みの顧客情報</li></ul>
        <p>今日を基準とした8件の架空の予約と顧客を作成します。ゴミ箱とメモは空になります。</p>
        {error && <p role="alert">{error}</p>}
        <div className="demo-reset-actions"><button type="button" className="button secondary" autoFocus onClick={() => dialog.current?.close()}>キャンセル</button><button type="button" className="button primary" onClick={confirmReset}>初期状態に戻す</button></div>
      </div>
    </dialog>
  </>;
}
