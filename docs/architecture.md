# GitHub と Cloudflare の連携構成

青木研 OB・OG会 情報ハブ（リポジトリ `gyakusu/aoki-lab-obog-2026`）で、GitHub と Cloudflare がどう連携しているかを記録する資料です。
2026年11月1〜2日に構築・検証した時点の構成です。秘密情報の「値」はこの文書には書きません（保管場所だけを示します）。

## 全体像

役割分担は次のとおりです。

- **GitHub**: ソースと公開済み写真の保管場所。GitHub Pages がサイトを配信し、GitHub Actions がビルドとデプロイを担う
- **Cloudflare Workers**: 写真投稿の受け付けと、幹事用承認画面（`/admin`）を提供するサーバーレス API
- **Cloudflare R2**: 未承認（pending）の写真だけを置く非公開ストレージ

```mermaid
flowchart LR
    subgraph People["人"]
        Guest["参加者<br/>スマホのブラウザ"]
        Admin["幹事<br/>ブラウザ"]
    end

    subgraph GH["GitHub"]
        Repo["リポジトリ<br/>aoki-lab-obog-2026（公開）"]
        Actions["GitHub Actions<br/>Build and deploy Pages"]
        Pages["GitHub Pages<br/>gyakusu.github.io"]
    end

    subgraph CF["Cloudflare"]
        Worker["Workers<br/>aoki-lab-obog-photos<br/>aoki-lab-obog-photos.gyakusu.workers.dev"]
        R2[("R2 バケット<br/>aoki-lab-obog-pending（非公開）")]
    end

    Guest -->|"案内・ギャラリー閲覧"| Pages
    Guest -->|"写真投稿 POST /api/upload"| Worker
    Admin -->|"承認画面 /admin"| Worker
    Worker -->|"pending 写真の読み書き<br/>バインディング PENDING_PHOTOS"| R2
    Worker -->|"承認時に GitHub API で<br/>photos/approved/ へコミット"| Repo
    Repo -->|"main への push"| Actions
    Actions -->|"dist をデプロイ"| Pages
```

ポイント:

- 未承認の写真は R2 にしか存在せず、公開リポジトリには入りません
- 承認された写真だけが Worker 経由でリポジトリにコミットされ、Actions のビルドでギャラリーに載ります
- サイト本体（Pages）は静的配信のみで、投稿の受け付けはすべて Worker が担います

## 写真投稿の流れ

```mermaid
sequenceDiagram
    participant G as 参加者ブラウザ
    participant P as GitHub Pages<br/>（投稿ページ）
    participant W as Cloudflare Worker
    participant R as R2（pending）

    G->>P: 投稿ページを開く
    Note over G: ブラウザ側で長辺1600pxへ<br/>縮小・再エンコード
    G->>W: POST /api/upload（写真と投稿情報）
    Note over W: Origin チェック<br/>（PAGES_ORIGIN と一致必須）
    Note over W: レート制限 30回/60秒・IP単位<br/>形式・サイズ・画素数を検査
    Note over W: EXIF等のメタデータを<br/>サーバー側で除去してから保管
    W->>R: pending/＜ID＞.bin と .json を保存
    W-->>G: 201 受付完了（承認待ち）
```

補足:

- 投稿先 URL は `site/config.js` の `UPLOAD_API_URL` で指定します（現在は Worker の URL）。末尾スラッシュは不要で、投稿コードが `/api/upload` を付けます
- メタデータ除去は 2026年11月2日にブラウザ依存をなくすため Worker 側へ移しました。除去できない画像は受け付けません

## 承認と公開の流れ

```mermaid
sequenceDiagram
    participant A as 幹事ブラウザ
    participant W as Cloudflare Worker
    participant R as R2（pending）
    participant GH as GitHub API
    participant ACT as GitHub Actions
    participant P as GitHub Pages

    A->>W: /admin を開き共有パスワードでログイン
    W->>R: pending 一覧を取得
    A->>W: 「承認して公開」を押す
    W->>R: 写真と投稿情報を読み出し
    W->>GH: photos/approved/＜ID＞.jpg と .json を<br/>main へコミット（PAT を使用）
    W->>R: pending の写真と情報を削除
    GH->>ACT: push を契機にワークフロー起動
    Note over ACT: サムネイル生成・gallery.json 生成<br/>event.json の必須項目と人数（37名）を検証
    ACT->>P: dist をデプロイ
    Note over P: 数分後にギャラリーへ反映
```

## サイト更新の流れ（お知らせ・当日案内など）

```mermaid
flowchart LR
    Edit["main へ push<br/>content/ や site/ の変更"] --> Build["Actions: npm run build<br/>SITE_PATH 配下に dist を生成"]
    Build --> Deploy["deploy-pages"]
    Deploy --> Site["公開サイト<br/>gyakusu.github.io/aoki-lab-obog-2026/＜SITE_PATH＞/"]
    Root["リポジトリ直下の URL"] --> Notice["リンクなしの案内ページのみ<br/>（本体は SITE_PATH 配下）"]
```

注意（2026年11月2日の実例）: リポジトリの **Settings → Pages → Build and deployment の Source は「GitHub Actions」** でなければなりません。「Deploy from a branch」のままだと Jekyll ビルド（README のページ）が Actions の生成物を上書きし、本体が 404 になります。

## 連携ポイント一覧（どこに何を設定したか）

| 設定 | 場所 | 内容 |
| --- | --- | --- |
| `UPLOAD_API_URL` | `site/config.js` | Worker の URL `https://aoki-lab-obog-photos.gyakusu.workers.dev` |
| R2 バインディング | `worker/wrangler.toml` | `PENDING_PHOTOS` → バケット `aoki-lab-obog-pending` |
| レート制限 | `worker/wrangler.toml` | `UPLOAD_LIMITER`、30回/60秒（会場 Wi-Fi で IP を共有するため緩め） |
| Worker の変数 | `worker/wrangler.toml` の `[vars]` | `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` / `PAGES_ORIGIN`（`https://gyakusu.github.io`） |
| `GITHUB_TOKEN` | Worker Secret（`wrangler secret put`） | fine-grained PAT。対象はこのリポジトリのみ、権限は Contents の Read and write のみ |
| `ADMIN_PASSWORD` | Worker Secret（`wrangler secret put`） | `/admin` の共有パスワード。幹事間でのみ共有 |
| `SITE_PATH` | GitHub Actions Secret（リポジトリ設定） | 公開 URL の末尾パス。値は参加者への共有 URL に含まれますが、この文書には記載しません |
| Pages の公開元 | Settings → Pages | Source = GitHub Actions |

使っていないもの:

- バケット `aoki-obog-photos` と、発行した R2 の S3 互換 API トークン
- （この節以降の記述は初回コミット時点で欠落していたため復元できていません。必要に応じて追記してください）