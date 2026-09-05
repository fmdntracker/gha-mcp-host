/**
 * The Durable Object's SQL schema and the meta key/value helpers over it.
 *
 * Kept beside the object instead of inside it so the shape of a stored command
 * is one readable list rather than something you reconstruct by reading every
 * UPDATE statement, and so the readers can be unit tested against plain rows
 * with no Durable Object anywhere in sight.
 */

/**
 * The slice of Cloudflare's SqlStorage used here. Structural on purpose: a test
 * can pass an in-memory stand-in without dragging in workers-types.
 */
export type Sql = {
	exec(query: string, ...bindings: any[]): { toArray(): any[] }
}

export type EnvState =
	| "provisioning"
	| "ready"
	| "destroying"
	| "expired"
	| "failed"
	| "lost"

export type CmdState = "queued" | "running" | "exited" | "killed" | "lost"

/**
 * A command is terminal when the runner has stopped having an opinion about it.
 * `lost` counts: it is a conclusion, not the absence of one.
 */
export function isTerminal(state: string | null | undefined): boolean {
	return state === "exited" || state === "killed" || state === "lost"
}

/**
 * Columns added after the first cut of this schema.
 *
 * Nothing has been deployed yet, so the CREATE TABLE below already declares all
 * of them and every statement here is a no-op today. They exist because "not
 * deployed yet" stops being true exactly once, and a Durable Object cannot be
 * dropped and re-created to pick up a column -- its storage outlives the code
 * that created it.
 */
const COMMAND_MIGRATIONS = [
	`ALTER TABLE command ADD COLUMN signal TEXT`,
	`ALTER TABLE command ADD COLUMN bytes_written INTEGER`,
	`ALTER TABLE command ADD COLUMN head_discarded_bytes INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE command ADD COLUMN output_capped INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE command ADD COLUMN warnings TEXT`,
	`ALTER TABLE command ADD COLUMN tail_b64 TEXT`,
	`ALTER TABLE command ADD COLUMN tail_start INTEGER`,
]

export function initSchema(sql: Sql): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
	sql.exec(`CREATE TABLE IF NOT EXISTS command (
		command_id TEXT PRIMARY KEY,
		idem_hash TEXT,
		state TEXT NOT NULL,
		exit_code INTEGER,
		signal TEXT,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		ended_at INTEGER,
		runtime_ms INTEGER,
		total_bytes INTEGER NOT NULL DEFAULT 0,
		bytes_written INTEGER,
		head_discarded_bytes INTEGER NOT NULL DEFAULT 0,
		output_capped INTEGER NOT NULL DEFAULT 0,
		last_output_at INTEGER,
		label TEXT,
		cwd TEXT,
		shell TEXT,
		killed_reason TEXT,
		warnings TEXT,
		tail_b64 TEXT,
		tail_start INTEGER
	)`)
	sql.exec(`CREATE TABLE IF NOT EXISTS queue (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		command_id TEXT NOT NULL UNIQUE,
		payload TEXT NOT NULL,
		claimed_by TEXT,
		claimed_at INTEGER
	)`)
	for (const stmt of COMMAND_MIGRATIONS) {
		// "duplicate column name" is the expected outcome here and the only one
		// worth swallowing, but it arrives as a generic error, so this cannot tell
		// it apart from a real failure. A real one surfaces on the first query that
		// needs the column, which is a better place to notice it than a boot loop.
		try {
			sql.exec(stmt)
		} catch {}
	}
}

export function mget(sql: Sql, k: string): string | null {
	const rows = sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()
	return rows.length ? String(rows[0].v) : null
}

export function mset(sql: Sql, k: string, v: string | number | null): void {
	if (v === null) {
		sql.exec(`DELETE FROM meta WHERE k = ?`, k)
		return
	}
	sql.exec(
		`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
		k,
		String(v),
	)
}

export function mnum(sql: Sql, k: string, d: number | null = null): number | null {
	const v = mget(sql, k)
	if (v === null) return d
	const n = Number(v)
	return Number.isFinite(n) ? n : d
}
