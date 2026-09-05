# VENDOR / 出典台帳 (broker)

> **重要**: 以前この台帳には `nmt3325/opencode-mcp-bridge` が移植元として記載されていました。
> 同リポジトリは beta/alpha 段階であるため、**移植元から全面的に排除しました**。
> 現在この台帳・コード・README・設計文書のいずれにも同リポジトリへの依存はありません。

単一の fork 元は存在しません。レイヤーごとに別々の上流から逐語移植しています。

---

## 0. 依存バージョン (一次情報)

npm registry は参照できなかったため、各上流の `package.json` を直接読んで確定しました。

| パッケージ | 版 | 根拠 |
| --- | --- | --- |
| `agents` | 0.22.0 | `cloudflare/agents` `packages/agents/package.json` blob `0d7463f8…` |
| `@modelcontextprotocol/server` | 2.0.0 (peer, 完全固定) | 同上 |
| `@modelcontextprotocol/client` | 2.0.0 (peer, 完全固定) | 同上 |
| `@modelcontextprotocol/sdk` | 1.30.0 (peer, 完全固定) | 同上 |
| `zod` | ^4 | 同上 (上流 devDep は `^4.5.4`) |
| `wrangler` | ^4.115.0 | `cloudflare/agents` ルート `package.json` blob `450b51fc…` |
| `@cloudflare/vitest-pool-workers` | ^0.19.1 | 同上 |

`agents` は上記 4 つを **optional でない peerDependencies** として宣言しています。したがって当リポジトリでも同じ版を明示し、`agents` が解決する版と食い違わせません。**「zod の major がどちらか未確定」という長く残っていた宿題は zod 4 で確定**しました。

---

## 1. MCP サーバ層

| | |
| --- | --- |
| 上流 | Cloudflare `agents` (`agents/mcp/server` の `createMcpHandler`) ＋ `@modelcontextprotocol/server@2.0.0` |
| ライセンス | MIT |
| 使用箇所 | `src/index.ts` の `/mcp` ルート |

採用理由 (Cloudflare 公式 handler-api ドキュメント原文):

> `McpAgent` is deprecated and feature-frozen.

> `createMcpHandler` creates a callable stateless MCP request handler from an MCP SDK v2 server factory.

**訂正**: 本台帳の旧版は「自作 JSON-RPC 層 `src/mcp.ts` は破棄」と書いていましたが不正確です。破棄したのは **自作の JSON-RPC トランスポート**だけで、`src/mcp.ts` は役割を変えて存続しています。

- `ToolDef` の SDK への登録 (zod スキーマの受け渡し)
- リクエストに `progressToken` がある場合のみ 5 秒間隔のハートビート送出
- 例外を `broker_internal` ＋ `on_error: "retry"` ＋ `retry_after_ms` に整形

### 実装時に踏んだ罠 2 件 (いずれも公式ドキュメント原文)

> JSON mode drops notifications emitted before a final result.

`responseMode: "json"` は SSE を張らずに済むため一見魅力的ですが、**最終結果より前に出た通知を捨てる**ため 60 秒対策と両立しません。既定のままにしています。

> Do not export the callable directly as a Worker's default export. Wrangler treats function default exports as `WorkerEntrypoint` classes.

このため `src/index.ts` は `export default { fetch(...) }` の形を保ち、`createMcpHandler` の戻り値を直接 default export しません。

---

## 2. ツール結果の表現 (`ok` / `fail`)

| | |
| --- | --- |
| 上流 | `modelcontextprotocol/typescript-sdk` |
| ライセンス | MIT |
| 取得 ref | `5119ee7fd7790e335a3fb60ef36f85334e2a6326` |
| 使用箇所 | `src/result.ts` |

上流 `docs/servers/tools.md` 原文:

> Arguments that fail the schema come back as an `isError: true` tool result; the handler never runs.

> The SDK validates `structuredContent` against `outputSchema` before the result leaves your server, and advertises the derived JSON Schema in `tools/list`

- `fail` は例外ではなく **`isError: true` の通常のツール結果**として返します。モデルがメッセージを読んで再試行できます。
- **訂正**: 旧版は「`isJsonPayload` 相当の検証は自作せず SDK の `outputSchema` 経路に載せる」と書いていましたが、`outputSchema` の宣言は **M2 に延期**しました。M1 の同形結果はフィールド数が多く、スキーマを二重管理すると片方だけ更新される事故が起きます。よって `isJsonPayload` は `src/result.ts` に**残して**おり、`structuredContent` は出力するものの検証責任は当面こちら側です。

---

## 3. テスト harness

| | |
| --- | --- |
| 上流 | `modelcontextprotocol/typescript-sdk` `docs/migration/support-2026-07-28.md` |
| ライセンス | MIT |
| blob | `01ae6f05422985e9e29be42a30cc29a1aff5c2f7` |

上流原文:

> There is no in-memory serving entry — `InMemoryTransport.createLinkedPair()` connects 2025-era instances only. To exercise 2026-07-28 behavior in tests without sockets, drive `createMcpHandler` directly through its fetch function

したがって harness は **`handler.fetch` 直叩き**です。`InMemoryTransport.createLinkedPair()` は `docs/advanced/custom-transports.md` が「the reference implementation and the baseline to test your transport against」と書いていますが、`createMcpHandler` のサーバはテストできません。

ただし Durable Object と `ctx.waitUntil` は `workerd` 上でしか動かないため harness は 2 層になります。

| 層 | 手段 |
| --- | --- |
| プロトコル / ツール定義 | in-process `handler.fetch` |
| DO・ロングポール・永続化 | `@cloudflare/vitest-pool-workers` |
| 純関数 (`ring` / `kill-reason` / `env-window` / `bytes`) | 素の vitest。DO 不要 |
| runner シミュレータ | `test/mock-runner.mjs` (存続) |
| ~~bash + wrangler dev + ポート待ち~~ | **`test/e2e.sh` は廃止** |

`src/env-window.ts` と `src/env-snapshot.ts` を Durable Object から切り出したのはこのためです。バイト窓の読み出しは 60 秒タイムアウト設計が全面的に依存する 1 関数であり、DO を起動せずに単体で叩けなければテストが書かれません。

---

## 4. 60 秒タイムアウトの扱い

`MCP error -32001: Request timed out` の 60 秒は Notion 固有の癖ではなく **プロトコルの既定値**です。

公式 SDK `docs/clients/calling.md`:

> `resetTimeoutOnProgress` restarts the request timeout on every update and `maxTotalTimeout` is the absolute cap

`packages/server/src/server/legacyInputRequiredShim.ts`:

> The no-op handler stamps a progressToken on the leg — without one, `resetTimeoutOnProgress` could never fire.

`packages/server/src/server/server.ts`:

> Per-leg timeout (ms) … sent with `resetTimeoutOnProgress: true`. Human-paced — deliberately far above the 60s protocol default. @default 600_000

延長の公式手段は存在しますが、発動には **クライアントが `progressToken` を送り、かつ `resetTimeoutOnProgress` を opt-in している両方**が必要で、サーバ側から強制できません。よって:

1. `withCap` (HARD 55s / SOFT 45s) を **自作で維持**します。これは新規実装で上流はありません。
2. `progressToken` が付いていれば `notifications/progress` を 5 秒間隔で送出します。opt-in 済みクライアントでは事実上タイムアウトが消え、していないクライアントには `withCap` が働きます。

---

## 5. 新規実装 (上流なし)

| 要素 | 説明 |
| --- | --- |
| `withCap(work, ms, fallback, signal?)` / `class Deadline` | 上記の理由により自作。`AbortSignal` 連動 |
| `src/bytes.ts` (`safeCut` / `stripAnsi` / `makeRedactor` / `renderWindow`) | **broker の read 時 1 箇所のみ**。下記の訂正参照 |
| `src/ring.ts` / `src/kill-reason.ts` / `src/env-window.ts` / `src/env-schema.ts` | 本プロジェクト固有 |
| DO ワイヤ契約 (`enroll` / `controlPoll` / `claimNext` / `ingestChunk` / `window` / `takePull` / `snapshot`) | 本プロジェクト固有 |

### 訂正: ANSI 処理は runner と「同一実装」ではありません

旧版は `safeCut()` を「runner 側と同一実装」と書いていました。設計変更により **runner 側からは削除**しました (`out.strip` と `makeStripper()` を廃止)。理由:

カーソル空間 (byte offset) に加工後のバイト列を混ぜると、加工規則を変えた瞬間に過去のオフセットの意味が変わります。オフセットは常に **runner が書いた生バイトに対する絶対位置**でなければならず、加工はカット地点 1 箇所に限られます。`src/bytes.ts` の INVARIANTS ブロックに明文化し、実際のカット地点は `src/tools-shared.ts` の `execResult` だけです。`EnvDO.window()` は生バイトを返すだけで一切加工しません。

同じ理由で `next_byte` と `partial_line_dropped` は DO の返り値から外しました。どちらもカットの帰結であり、カットする側が算出すべき値です。

### `window` 契約への追加フィールド

| フィールド | 意味 |
| --- | --- |
| `bytes_written` | `output_cap` は「cap 以上」しか保証しないため、実際の書き込み量を必ず返す |
| `head_discarded_bytes` | この窓が飛ばした先頭バイト数 (もう誰も再送できない分) |
| `output_capped` | cap により打ち切られたか |

### 終了時の永続化 (決定 18)

コマンドが終端状態に達した時点で、末尾 32 KiB ＋ `exit_code` ＋ `runtime_ms` ＋ `killed_reason` を DO の SQLite に保存します。**終わったコマンドの exit code が、それを説明する出力より長生きしてはならない**ためです。isolate が入れ替わってリングが消え、runner のリースも切れた後は、この末尾が唯一残る出力になります。

このとき窓は `range_evicted` を返さず、**末尾まで前進して** `head_discarded_bytes` に飛ばした量を入れます。runner が既に居ないのに「pull で取れる」と案内すると、誰も応答しない 15 秒の待ちを生むだけです。runner が生きている間は逆に `range_evicted` を返し、`out.raw` からの再送に委ねます。

### `killed_reason` の値域と優先順位

| 優先 | 値 | 発火条件 |
| --- | --- | --- |
| 1 | `enospc` | **エージェント自身の write が実際に ENOSPC を返したときのみ** |
| 2 | `output_cap` | `bytes_written >= cap` |
| 3 | `timeout` / `inactivity` | 従来通り。**無出力は常に `inactivity`** |
| 4 | `user` | `kill` アクション |
| 5 | `spawn_gap` | control がプロセスを見失う (`state='lost'`) |

空き容量のフロアは kill を **発火しません**。適応ポーリング間隔の入力にすぎません。`exit_code` は常に生値を返し、`killed_reason !== null` のときはクライアント側が `killed_reason` を優先表示します (加工ではなく並置。-32001 リトライで同じ行を再読したときに解釈が変わらないため)。

#### `enospc` を一級の終了条件にする理由

`write(2)`:

> Note that a successful `write()` may transfer fewer than *count* bytes. Such partial writes can occur … because there was insufficient space on the disk device to write all of the requested bytes

ENOSPC はエラーではなく **黙った部分書き込み**として現れ得ます。さらに Red Hat KB の busybox 実例では、`/dev/full` への書き込み失敗後に別ファイルへ書くと内容が `abcd12345` に混ざります。ディスク満杯後の出力は信用できないため、継続ではなく終了条件に昇格させます。

---

## 6. 旧コードで発見し修正したバグ

いずれも自作部分の欠陥で、上流に責任はありません。共通点は **どれも例外を投げずに黙って壊れる**ことです。

| # | 箇所 | 症状 | 修正 |
| --- | --- | --- | --- |
| 1 | runner `agent.mjs` の `posixScript` | `exec 0</dev/null` を出力する一方で `runCommand` は `stdin.bin` を fd 0 として渡していたため、**呼び出し側が渡した stdin が黙って捨てられていた** | 当該行を削除。再導入禁止 |
| 2 | `env-do.ts` のリング | 追い出しに `subarray()` を使っていたため、**その env が一度受け取った全 ArrayBuffer を環境の寿命いっぱい生存させ続けていた** | `src/ring.ts` で `slice()` に変更 |
| 3 | `env-do.ts` の `killed_reason` | `COALESCE(?, killed_reason)` は**最初に届いた理由**を残す。runner は OS が明かした順に報告するので、ディスク満杯が「inactivity タイムアウト」として記録されていた | `src/kill-reason.ts` の優先順位で JS 側マージ |
| 4 | `tools.ts` の evicted range 再送 | `next_byte = got.start + Math.floor((bytes_b64.length*3)/4)` は padding 付き base64 で**最大 2 バイト過大**になり、カーソルが実出力を飛び越えていた | 廃止。デコード後のバイト数から算出 |

書き換えでは併せて、再配送されたチャンクが `total_bytes` を巻き戻したり、判明済みの `exit_code` を消したり、有効な末尾を空で上書きしたりできないよう、全フィールドを保存済みの行に対して単調にマージするようにしました。`start_byte` は連番ではなく重複排除キーであり、再配送は異常ではなく正常系です。

---

## 7. 削除したもの

| 対象 | 理由 |
| --- | --- |
| `src/config.ts` の `DEFAULT_DENY_PATTERNS` / `wildcardMatch` / `checkCommand` | セキュリティシアター。リポジトリ書き込み権限を持つトークンが載ったマシンのシェルを文字列一致で安全化することはできず、`curl \| sh` や base64 で自明に回避される。実効的な統制はリースの短さ・runner の使い捨て・作成レート制限・トークンのスコープ |
| runner の `out.strip` / `makeStripper()` | カット地点を broker の read 時 1 箇所に集約 (§5) |
| `test/e2e.sh` | `handler.fetch` の in-process テストへ置換 |
| 自作 JSON-RPC トランスポート | `createMcpHandler` へ置換 (`src/mcp.ts` 自体は存続) |

---

## 8. ライセンス同梱

| パス | 内容 |
| --- | --- |
| `third_party/gemini-cli/LICENSE` | Apache-2.0 全文 (§4a)。runner 側 `vendor/process-utils.mjs` の出典 |
| `third_party/actions-runner/LICENSE` | MIT 全文。pwsh 定句の出典 |
| `third_party/mcp-typescript-sdk/LICENSE` | 上流 LICENSE 全文 (移行告知 ＋ Apache-2.0 ＋ MIT ＋ CC-BY-4.0 告知の 4 部構成) |

Apache-2.0 §4 原文:

> (b) You must cause any modified files to carry prominent notices stating that You changed the files; and (c) You must retain, in the Source form of any Derivative Works …, all copyright, patent, trademark, and attribution notices from the Source form of the Work

§4(b)(c) は台帳では満たせません。改変したファイル自身に告知が必要です。runner 側 `vendor/process-utils.mjs` は上流ヘッダーを逐語保持し、その直後に `NOTICE OF MODIFICATION — required by Apache License 2.0 §4(b)` として改変 6 点を列挙しています。broker 側に Apache-2.0 由来の改変ファイルはありません。

Apache-2.0 §4(d) の NOTICE 同梱義務は **発生しません** — `google-gemini/gemini-cli` のルートツリー (41 エントリ) を全数確認し、`NOTICE` ファイルが存在しないことを確認済みです.
