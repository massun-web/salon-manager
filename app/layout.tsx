import type { Metadata } from "next";
import "./globals.css";
import { DemoWorkspace } from "./components/demo-workspace";

export const metadata: Metadata = {
  title: "Salon Manager",
  description: "サロンの予約・顧客管理Webアプリ",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body><a href="#main-content" className="skip-link">メインコンテンツへ移動</a><DemoWorkspace>{children}</DemoWorkspace></body>
    </html>
  );
}
