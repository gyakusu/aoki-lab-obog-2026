# 青木研究室 OB・OG会 情報ハブ

2026年11月14日（土）開催の青木研究室 OB・OG会向け案内サイトです。GitHub Pages で公開し、写真投稿と承認には Cloudflare Workers + R2 を使います。

> **公開前の注意:** GitHub リポジトリと Pages サイトは公開です。URLの秘匿や `noindex` はアクセス制御ではありません。メールアドレス、出欠情報、参加者名簿を掲載しないでください。グループ表に参加者名を入力する場合も、参加者全員が見られる範囲に公開してよい情報かを幹事が確認してください。会場・連絡先などが未設定のままでは公開しないでください。

## 構成

- `site/`: スマートフォン対応の案内・投稿・ギャラリー画面
- `content/announcements/*.md`: 幹事からのお知らせ。日付の新しい順にトップへ表示
- `content/event.json`: 当日案内の公開設定
- `photos/approved/`: 幹事が承認した公開画像とメタデータ
- `scripts/build-site.js`: お知らせ・写真一覧、サムネイルの生成と容量/EXIF検査
- `.github/workflows/pages.yml`: GitHub Actions のビルド・Pages デプロイ
- `worker/`: 匿名投稿 API と共有パスワード保護の承認画面/API
- `docs/architecture.md`: GitHub と Cloudflare の連携構成（Mermaid 図と運用手順）

未承認画像は Cloudflare R2 にのみ保存します。承認操作後に Worker が画像と公開用メタデータを GitHub リポジトリへ登録し、Actions が Pages を更新します。ギャラリーへの反映はデプロイ完了後です。

## ローカルビルド

Node.js 22 以降を使用してください。

```sh
npm install
npm run build
npm test
```

生成物は `site/generated/`、`site/photos/`、`dist/local-preview/` に作られます（Git 管理対象外）。サイトをローカルで確認する場合は、任意の静的 HTTP サーバーで `dist/` を配信してください。

## 告知の追加

`content/announcements/` に `.md` ファイルを追加します。ファイル名は `YYYY-MM-DD-short-title.md` の形式を推奨します。先頭にタイトルと日付を置き、その下に本文を書きます。

```md
---
title: 研究室見学について
date: 2026-11-01
---

LINE公式アカウントで配信した案内と同じ本文を掲載してください。
本文は見出し、箇条書き、太字、コード、http/httpsリンクに対応しています。
```

変更を `main` に反映すると GitHub Actions が自動で公開します。告知には参加者のメールアドレス、出欠、アレルギー等を含めないでください。

## 当日情報・連絡先の設定

`content/event.json` の会場、地図リンク、3グループの引率者・メンバー、会食情報、遅刻・欠席の連絡方法、連絡先を編集します。連絡先の表記は Google Forms の公開表記に合わせてください。値が揃っていない状態では公開しないでください。参加者のメールアドレスは記載しません。

緊急連絡先を差し替える場合も `contactLabel`、`contactDetails`、`lateOrAbsentInstructions` のみを編集し、内容を確認して `main` に反映します。連絡先の変更が告知として必要な場合は、同じ内容のお知らせ Markdown も追加してください。

## 写真投稿・承認

- OB・OG／在学生に加えて青木先生も投稿します。フォームの「立場」で「教員（青木先生）」を選ぶと入学年度は不要になり、公開メタデータは `role: "faculty"`、`enrollmentYear: null` になります（ギャラリーでは「教員」と表示）。撮影時期は2007〜2026年の1年単位で選び、年が分からない場合は「2010年代」「2020年代」または「年代不明」を選べます。
- 投稿者は JPEG/PNG/WebP を一度に最大3枚投稿できます。ブラウザ側で長辺1600pxへの縮小と圧縮を行い、1枚5MB（Worker の上限）に収めてから送信します。元のファイルが5MBを超えていても、圧縮で収まれば投稿できます。Worker は形式・実サイズを検査したうえで、EXIF等のメタデータを除去してから保管します（除去できない場合は受け付けません）。
- 送信直後は R2 の非公開 `pending/` に保存され、一般のギャラリーや公開リポジトリからは見えません。Worker は送信元サイトの Origin と IP 単位のレート制限（30回/分。会場 Wi-Fi などで参加者が同じ IP を共有するため緩めに設定。入力ミスでは回数を消費しません）も確認します。Cloudflare Rate Limiting API は拠点ごとの概算値であり、厳密な上限ではありません。
- 幹事は `https://<Workerのホスト>/admin` を開き、共有パスワードを入力します。写真と投稿情報を確認し、必要なら投稿者名・キャプションの誤字を直してから「承認して公開」または「却下して削除」（確認あり）を選びます。複数の写真は「まとめて承認する」にチェックを入れ（「すべて選択」も可）、「選択した写真をまとめて承認」で一括承認できます。承認は一括の場合も GitHub へのコミットが競合しないよう1件ずつ順に処理されます。承認後、画像とメタデータがリポジトリにコミットされ、Actions がサムネイル等を生成して公開します。
- 公開写真は合計100MBを目安とし、ビルドは1GB超過を拒否します。公開後に削除する場合は `photos/approved/` の画像と対応する JSON を削除して `main` に反映し、R2 の pending 投稿も管理画面で削除してください。
- 投稿者名・立場・入学年度・撮影時期・キャプションは公開メタデータになります。公開前に内容を必ず確認してください。削除依頼・問い合わせ先を当日案内とギャラリーに掲載してください。

## GitHub Pages と Cloudflare の初期設定

1. GitHub リポジトリの **Settings → Pages → Build and deployment** で **GitHub Actions** を選択します。
2. `content/event.json` の会場・地図・連絡方法・3グループ37名の情報を確定して入力します。Actions は必須項目が未設定、グループ人数が37名でない場合に公開ビルドを失敗させます。「ダミー」「未定」「TBD」等を含む仮の値はビルドを止めず、公開用データから除いて「未設定」と表示します（Actions のログに警告が出ます）。ローカルビルドでは仮の未設定表示を確認できますが、公開前に必ず実情報を設定してください。
3. **Settings → Secrets and variables → Actions** に `SITE_PATH` Secret を作成し、パスワードマネージャー等で生成したランダムな32文字の小文字16進数を登録します（受け付ける形式は8〜64文字の小文字英数字/ハイフン）。サイトは `https://<owner>.github.io/<repository>/<SITE_PATH>/` で公開されます。ルートにはサイトへリンクしない案内ページだけを置き、参加者には完全なURLをLINE等で共有してください。公開リポジトリの Action artifact 等からパスが発見される可能性はあるため、これはアクセス制御ではありません。
4. Cloudflare で `aoki-lab-obog-pending` という非公開 R2 bucket を作り、Wrangler を使って Worker をデプロイします（Rate Limiting API の設定に Wrangler 4.36.0 以降が必要です）。`worker/wrangler.toml` の `PAGES_ORIGIN` を実際の Pages origin（例: `https://gyakusu.github.io`）に合わせます。独自ホスト名を使う場合はその origin に更新してください。`UPLOAD_LIMITER` の `namespace_id` は Cloudflare アカウント内で一意な整数にしてください。
5. Fine-grained PAT を作成し、Resource owner と Repository access をこのリポジトリだけに限定します。Repository permissions は **Contents: Read and write** のみを付与します。有効期限を設定し、PAT をソース・Actions のログ・ブラウザに貼り付けないでください。
6. `worker/` で Wrangler を実行し、以下を Worker Secret として登録します。管理パスワードは長くランダムな値にし、幹事だけで共有します。

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler deploy
   ```

7. デプロイされた Worker の URL を `site/config.js` の `UPLOAD_API_URL` に設定して `main` へ反映します。サイトの origin と Worker の `PAGES_ORIGIN` が一致しないと投稿できません。
8. `main` への push 後に Actions が成功したら、生成された `SITE_PATH` を含む URL を参加者に共有します。実運用前に、公開予定の連絡先・グループ情報、匿名投稿、R2 pending、管理画面での承認、Pages 反映、削除をテストしてください。無料枠条件や上限は変更されることがあるため、公開前に最新の公式条件を確認してください。

   現在の公式資料では、Workers Free は1日10万リクエスト・1呼び出しあたりCPU時間10ms、R2 Standard は月10GB-month・Class A 100万回/月・Class B 1,000万回/月が無料枠です。GitHub Pages の公開サイト上限は1GBです。未承認 R2 データは100MB/200枚で受付を止め、Pages ビルドも出力全体が1GBを超えると失敗します。レート制限は概算であり、無料枠の超過防止を保証するものではありません。利用状況は Cloudflare と GitHub の各ダッシュボードで確認してください。

   - [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
   - [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
   - [Cloudflare Worker Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
   - [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## トークンの更新・漏えい時

Fine-grained PAT の期限前に新しい PAT を発行し、同じリポジトリ限定・Contents のみの権限で `npx wrangler secret put GITHUB_TOKEN` を実行します。管理画面で承認投稿ができることを確認してから古い PAT を失効させます。漏えいが疑われる場合は直ちに GitHub で失効し、新しい PAT に入れ替え、Worker を再デプロイしてください。PAT はサイト設定や GitHub Pages のクライアントコードに置きません。

管理パスワードが漏えいした場合は新しい共有パスワードを `npx wrangler secret put ADMIN_PASSWORD` で登録し、Worker を再デプロイして幹事に安全な方法で共有します。

## イベント後のアーカイブ

1. 告知と当日案内に開催済みであることを追記し、連絡先・会場の不要な詳細を公開し続けるか幹事で確認します。
2. 写真の削除依頼に対応し、R2 の未承認写真を承認または削除します。写真投稿を終了する場合は Worker を停止するか投稿 API を無効にし、`site/config.js` の投稿先設定も無効化します。
3. Pages を継続公開するか、リポジトリをアーカイブするかを幹事で決めます。リポジトリをアーカイブすると Worker からの新しい Contents 書き込みもできなくなるため、投稿を停止した後に行います。
4. 不要になった Worker Secrets と R2 の pending データを削除し、PAT を失効させます。公開リポジトリの過去コミットに含まれる承認済み写真は履歴からも取得可能な点に留意してください。