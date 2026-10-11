# 公開前の依存関係セキュリティ確認

確認日：2026-10-12（日本時間）。結論：一般公開は保留を推奨。最新auditが取得できず、近日公開予定のCritical/Highの対象範囲も未確認のため、安全性の確認完了とは判断しない。

## 現在のバージョン

`npm ls` と package-lock.json の実際の解決バージョンを照合した。package.json の範囲指定と区別する。

| パッケージ | インストール済み | 区分 | package.jsonの指定 |
| --- | --- | --- | --- |
| next | 16.3.8 | 本番用 | ^16.0.0 |
| react / react-dom | 19.3.0 | 本番用 | ^19.2.0 |
| eslint-config-next | 16.3.8 | 開発用 | ^16.0.0 |
| eslint | 9.39.5 | 開発用 | ^9.0.0 |
| typescript | 5.9.3 | 開発用 | ^5.9.0 |

## 実行結果と更新判断

- `npm audit --json` と `npm audit --omit=dev --json` をそれぞれ実行。キャッシュを `.npm-cache` に指定し、再試行0回、通信タイムアウト10秒。どちらもEACCESの通信エラー・終了コード1。最新の件数、全依存および本番用依存の網羅的な結果は未確認。
- `npm view next@16 version --json` と `npm view eslint-config-next@16 version --json` もEACCES。npmで取得できる最新修正版の一覧は未確認。
- 公式Web情報は参照できたが、対象範囲・修正版が不明な情報を根拠に更新しない。Next.js 16.4のリリース告知はあるが、今回の未公表問題の修正版だとは判断しない。
- package.json、package-lock.json、インストール済み依存は変更なし。override、強制修正、メジャー更新なし。
- 自動テスト10件成功、lint・型チェック・buildすべて終了コード0。これらは機能・構文の検証であり、脆弱性がないことを保証する検査ではない。

## 開発用依存の既知の問題

eslint-config-next 16.3.8 → @next/eslint-plugin-next 16.3.8 → fast-glob 3.3.1 → micromatch 4.0.8 → braces 3.0.3。lockfileで全てdev=trueと確認。

[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) はHigh、braces <=3.0.3が対象。深くネストしたglobでスタックが枯渇し、Node.jsプロセスを停止させる可能性がある。確認時点で公表された修正版はない。

この経路はLintの開発用依存で、予約・顧客の入力をbracesに渡す処理はない。本番用依存のみのインストールにはこの開発用経路は含まれない。ただし開発・CI・ビルド環境にインストールされる場合のリスクは残る。外部の信頼できないglobをLint設定に取り込まない。過去のHigh 5件はこの依存経路に関する報告で、今回は再取得できていないため現在の件数としては断定しない。

## 本番用依存の確認

今回参照できた公式情報との照合結果（全アドバイザリを網羅した結果ではない）：

| アドバイザリ | 重大度 | 照合結果 |
| --- | --- | --- |
| [next/og ImageResponse RCE](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) | Critical | >=16.2.0 <16.3.6が対象、16.3.6で修正。現在16.3.8は対象外。アプリにnext/ogの利用もない |
| [AVIF画像最適化RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4) | Critical | 16系は16.3.3未満が対象、16.3.3で修正。現在16.3.8は対象外 |
| [WindowsホストRCE](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) | Critical | >=16.0 <16.3.3が対象、16.3.3で修正。現在16.3.8は対象外 |
| [SSG/ISRキャッシュ汚染](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p) | Moderate | 取得した公式ページの修正版欄は16.3.?で確定版不明。ルート階層のcatch-allとSSG/ISRの組合せが条件。このアプリにはルート階層のcatch-allがないため、説明された条件には該当しないと判断。修正済みの断定はしない |
| [Draft Modeとuse cacheの情報漏洩](https://github.com/vercel/next.js/security/advisories/GHSA-3w37-wq28-93x7) | Moderate | 取得した対象欄は16.3.0、修正版欄は16.3.?。このアプリはDraft Mode・use cache・Cache Componentsを使用しておらず、説明された条件には該当しないと判断 |

React / react-dom 19.3.0のインストールを確認。npm auditが取得できないため、これらやNext.jsに同梱される上流依存も含めて未解決問題が0件とは判断できない。

[Next.js公式の10月8日告知](https://nextjs.org/blog/upcoming-nextjs-security-update-october-2026) は、10月14日に上流依存のCritical 2件・High 1件の修正を予定している。対象バージョン・影響・更新手順は更新時に公表するとされ、現在の16.3.8が影響を受けるかは未確認。既存の修正3件とは別に確認が必要。

## 公開を再判断する条件

1. 通信可能な環境で全依存と本番用依存のnpm auditを再取得し、未解決項目を分類する。
2. 10月14日の正式アドバイザリと修正版を確認する。影響を受ける場合は互換性のある修正版へNext.jsと対応するeslint-config-nextを更新し、必要なReact関連更新も照合する。
3. 更新後に自動テスト・lint・型チェック・build・ブラウザ操作確認を再実行する。修正が必要な本番用Critical/Highを解消したことを確認してから公開を再判断する。
4. 開発用bracesの未修正問題は本番用問題とは区別して継続追跡する。audit件数を消すための互換性不明な置換は行わない。

localStorageの既存データは読み書きしていない。commit・push・デプロイは実施していない。
