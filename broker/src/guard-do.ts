import { DurableObject } from "cloudflare:workers"

/**
 * Singleton guard for the two things that must be enforced in code rather than
 * in prose, because the previous system proved that a `hint` telling the AI to
 * stop is simply not read:
 *
 *   1. a circuit breaker for account suspension
 *   2. a hard cap on env_create per hour
 *
 * The cap exists because the breaker can only open AFTER the first 403, which is
 * already too late to prevent whatever pattern triggered the suspension.
 */
export class GuardDO extends DurableObject {
	private get sql() {
		return this.ctx.storage.sql
	}

	private init() {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS creates (ts INTEGER NOT NULL)`)
		this.sql.exec(`CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
	}

	private get(k: string): string | null {
		this.init()
		const rows = this.sql.exec(`SELECT v FROM state WHERE k = ?`, k).toArray() as any[]
		return rows.length ? String(rows[0].v) : null
	}

	private set(k: string, v: string) {
		this.init()
		this.sql.exec(
			`INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
			k,
			v,
		)
	}

	async breaker(): Promise<{ open: boolean; code: string | null; message: string | null; since: number | null }> {
		const raw = this.get("breaker")
		if (!raw) return { open: false, code: null, message: null, since: null }
		try {
			const j = JSON.parse(raw)
			return { open: true, code: j.code, message: j.message, since: j.since }
		} catch {
			return { open: false, code: null, message: null, since: null }
		}
	}

	async trip(code: string, message: string): Promise<void> {
		this.set("breaker", JSON.stringify({ code, message, since: Date.now() }))
	}

	async reset(): Promise<void> {
		this.init()
		this.sql.exec(`DELETE FROM state WHERE k = 'breaker'`)
	}

	async allowEnvCreate(
		maxPerHour: number,
	): Promise<{ allowed: boolean; used: number; max: number; retryAfterMs: number | null }> {
		this.init()
		const cutoff = Date.now() - 3_600_000
		this.sql.exec(`DELETE FROM creates WHERE ts < ?`, cutoff)
		const rows = this.sql.exec(`SELECT ts FROM creates ORDER BY ts ASC`).toArray() as any[]
		if (rows.length >= maxPerHour) {
			const oldest = Number(rows[0].ts)
			return {
				allowed: false,
				used: rows.length,
				max: maxPerHour,
				retryAfterMs: Math.max(1000, oldest + 3_600_000 - Date.now()),
			}
		}
		this.sql.exec(`INSERT INTO creates (ts) VALUES (?)`, Date.now())
		return { allowed: true, used: rows.length + 1, max: maxPerHour, retryAfterMs: null }
	}

	/** Called when a dispatch failed, so a failed create does not burn quota. */
	async refundEnvCreate(): Promise<void> {
		this.init()
		this.sql.exec(`DELETE FROM creates WHERE ts = (SELECT MAX(ts) FROM creates)`)
	}
}
