# 自宅サーバーへの移行（Docker Compose）

ブローカーだけを **Node.js 24 + ローカル SQLite** に移します。Linux / macOS /
Windows のコマンド実行先は引き続き GitHub Actions です。Cloudflare Workers、
Durable Objects、Wrangler、Cloudflare の契約・認証情報はコンテナには不要です。

## 起動

Docker Engine と Docker Compose v2 を用意し、リポジトリのルートで実行します。

```bash
git clone https://github.com/fmdntracker/gha-mcp-host.git
cd gha-mcp-host
cp .env.example .env
chmod 600 .env
# .env の下記4項目を編集
```

- `PUBLIC_URL`: GitHub-hosted runner と MCP クライアントの両方から届く HTTPS の
  origin（例: `https://mcp.example.com`）。末尾に `/mcp` を付けないでください。
- `GITHUB_PAT_DISPATCH`: runner リポジトリに Actions read/write を持つ PAT。
- `BROKER_SECRET`: GitHub Actions の同名 secret と一致する値。
- `MCP_AUTH_TOKEN`: MCP クライアント用の独立した bearer token。
  新規生成する場合は `openssl rand -hex 32`。既存値の再利用も可能です。

GHCR のビルド済みイメージを使う場合:

```bash
docker compose pull
docker compose up -d --wait
curl --fail http://127.0.0.1:8787/healthz
```

初回のイメージ公開前、またはローカルでビルドする場合:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

既定ではホストの `127.0.0.1:8787` にだけ公開します。既存のリバースプロキシから
このポートに接続してください。別マシンから接続する必要がある場合だけ
`BIND_ADDRESS` を変更します。プロキシが Host を書き換える場合は、その正確な
`host:port` を `ALLOWED_HOSTS` に追加してください。`X-Forwarded-*` は信頼しません。

## HTTPS も Compose で用意する場合

既存のプロキシがなければ、任意の Caddy 構成を追加できます。

1. 公開 DNS の A/AAAA レコードを自宅の到達可能なアドレスに設定します。
2. ルーターの TCP 80/443 をこのサーバーへ転送します。
3. `.env` の `PUBLIC_URL` を実際の `https://ホスト名` に設定します。
4. 起動します。

```bash
docker compose -f compose.yaml -f compose.https.yaml up -d --wait
# ローカルビルドも併用する場合:
docker compose -f compose.yaml -f compose.build.yaml -f compose.https.yaml up -d --build --wait
```

Caddy が証明書を取得・更新します。SSE は即時転送し、長時間ポーリングを妨げない
設定です。既存の nginx 等を使う場合は `/mcp` と `/agent/*` でレスポンスバッファを
無効にし、read timeout を 90 秒以上にします。CGNAT などで外から到達できない場合は
別途トンネルや公開プロキシが必要です。ホストの公開・DNS・TLS はこのリポジトリの
変更だけでは自動設定されません。

## Cloudflare からの切り替え手順

1. 旧ブローカーの利用を止め、既存の runner ジョブを終了・キャンセルします。
   新旧で状態は共有しません。Cloudflare の稼働中環境・トークン・履歴の自動移行は
   行わず、新しい環境として作り直します。
2. 自宅ブローカーを起動し、公開 URL の `/healthz` に外部から到達できることを確認します。
3. `fmdntracker/gha-mcp-host` → Settings → Secrets and variables → Actions で
   `BROKER_URL` を新しい HTTPS origin に変更します（`/mcp` は付けません）。
   `BROKER_SECRET` も `.env` と一致させます。secret の値をコードに入れないでください。
4. MCP 接続を `https://ホスト名/mcp` に変更し、Bearer 認証に `MCP_AUTH_TOKEN` を設定します。
5. `env_create` → `exec` → `env_destroy` を新 URL で確認します。
6. 動作を確認したら旧 Worker と Workers Builds の自動デプロイを停止できます。

GitHub Actions の runner workflow と利用制限・TTL・作成レート制限は変更しません。
コードのマージは `BROKER_URL`、secret、DNS、MCP 接続や旧 Worker を変更しません。

## 自動イメージビルド

`.github/workflows/docker-publish.yml` が以下を行います。

- PR: Node の統合テスト、SQLite の永続化・並列実行テスト、Compose 設定検証、
  非 root / read-only の本番コンテナでスモークテスト。レジストリへの push はしません。
- `main` の関連ファイル変更: 上記の成功後、GHCR に `latest` と `sha-*` を公開。
- `v*` タグ: SemVer タグと `sha-*` を公開。タグから `latest` を上書きしません。
- Actions の手動実行: `main` ならビルド・公開、他ブランチなら検証のみ。
- 対応アーキテクチャ: `linux/amd64`、`linux/arm64`。

イメージは `ghcr.io/fmdntracker/gha-mcp-host:latest` です。公開には自動提供される
`GITHUB_TOKEN` の `packages: write` を使い、追加のレジストリ用 PAT は不要です。
初回に GHCR パッケージが private になった場合はパッケージ設定で public にするか、
サーバー側で `read:packages` の認証情報を使って `docker login ghcr.io` してください。

**イメージの自動ビルド・公開と、自宅サーバーの自動更新は別です。** SSH 認証情報や
Docker socket を CI に渡す構成は入れていません。更新時は次を実行します。

```bash
docker compose pull
docker compose up -d --wait
docker compose logs --tail=100 broker
```

固定・ロールバックには `.env` の `GHA_MCP_IMAGE` を公開済み `sha-*` タグまたは digest
に変更します。Caddy / local build を併用する場合は起動時と同じ `-f` を付けてください。

## 永続化と運用

- named volume `broker_data` に環境・キュー・実行結果の末尾・レート制限を保存します。
- 同じデータディレクトリを使えるブローカープロセスは **1つ** です。起動時の SQLite
  排他ロックで二重起動を拒否します。複数レプリカや NFS 上の DB は対象外です。
- 再起動時、HTTP / SSE 接続は切断されます。runner は再接続します。実行中出力の
  メモリキャッシュは再取得でき、完了した出力の末尾は SQLite から読めます。
  未配信の一時的な control action はメモリ上なので、必要なら状態確認後に再要求してください。
- 10分アクセスされていない環境の DB ハンドルとメモリキャッシュは閉じます。
  SQLite ファイルは履歴として保持されます。ディスク使用量は監視してください。
- `docker compose down` はデータを残します。**`down -v` はデータを削除します。**
- バックアップは broker を停止してから named volume 全体をコピーし、停止中の
  broker に復元してください。SQLite の WAL / SHM を除外しないでください。
- 既定コンテナは非 root、root filesystem は read-only、ホストの Docker socket は
  マウントしません。実行するシェルは自宅ホストではなく GitHub-hosted runner 上です。

## 開発・検証

```bash
cd broker/selfhost
npm install --no-audit --no-fund
npm run build
npm test
```

自己ホスト用の依存関係はこのディレクトリに分離しています。共有するのは既存
`broker/src/` のルーティング・認証・MCP ツール・SQL ロジックです。ビルド時に
`cloudflare:workers` の最小インターフェースをローカル SQLite 実装へ、Agents の
MCP facade を同じ MCP v2 SDK の HTTP ハンドラへ置き換えます。Wrangler の開発
サーバーを本番利用する方式ではありません。

Node を直接動かす場合は `MCP_AUTH_TOKEN_FILE` / `BROKER_SECRET_FILE` /
`GITHUB_PAT_DISPATCH_FILE` も使えます。同名の値と `_FILE` を同時に設定すると起動を
拒否します。標準 Compose は `.env` 方式です。
