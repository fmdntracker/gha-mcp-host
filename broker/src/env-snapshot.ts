import { mget, mnum, type EnvState, type Sql } from "./env-schema"

export function queueDepth(sql: Sql): number {
	const rows = sql.exec(`SELECT COUNT(*) AS c FROM queue`).toArray()
	return rows.length ? Number(rows[0].c) : 0
}

const COMMANDS_SCAN_LIMIT = 60
const COMMANDS_BUDGET_BYTES = 8 * 1024
const DISK_LOW_MB = 2048

/**
 * Everything env_status and env_list report about one environment.
 *
 * Read-only over the tables, so it can be exercised directly in tests.
 */
export function buildSnapshot(sql: Sql, verbose: boolean): Record<string, unknown> {
	const ttl = mnum(sql, "ttl_expires_at", 0)!
	let state = (mget(sql, "state") || "lost") as EnvState
	if (state === "ready" && Date.now() > ttl) state = "expired"

	// Byte-capped, newest first. A count cap lets one row with a long label blow
	// the response budget, which is the resource that is actually scarce.
	const rows = sql
		.exec(
			`SELECT command_id, state, exit_code, total_bytes, label, created_at, runtime_ms, killed_reason
			 FROM command ORDER BY created_at DESC LIMIT ?`,
			COMMANDS_SCAN_LIMIT,
		)
		.toArray()
	const commands: any[] = []
	let budget = COMMANDS_BUDGET_BYTES
	let commandsTruncated = false
	for (const r of rows) {
		const item = {
			command_id: String(r.command_id),
			state: String(r.state),
			exit_code: r.exit_code === null ? null : Number(r.exit_code),
			total_bytes: Number(r.total_bytes) || 0,
			runtime_ms: r.runtime_ms === null ? null : Number(r.runtime_ms),
			killed_reason: r.killed_reason ? String(r.killed_reason) : null,
			label: r.label ? String(r.label).slice(0, 64) : null,
		}
		const cost = JSON.stringify(item).length
		if (cost > budget) {
			commandsTruncated = true
			break
		}
		budget -= cost
		commands.push(item)
	}

	const lastSeen = mnum(sql, "last_seen_at", null)
	const diskFree = mnum(sql, "disk_free_mb", null)
	const warnings: string[] = []
	if (diskFree !== null && diskFree < DISK_LOW_MB) {
		warnings.push(`disk space low: ${diskFree} MiB free on the runner`)
	}

	const base: Record<string, unknown> = {
		env_id: mget(sql, "env_id"),
		platform: mget(sql, "platform"),
		state,
		label: mget(sql, "label"),
		run_url: mget(sql, "run_url"),
		run_id: mget(sql, "run_id"),
		created_by: mget(sql, "created_by"),
		expires_at: ttl,
		ttl_remaining_s: Math.max(0, Math.floor((ttl - Date.now()) / 1000)),
		sticky_cwd: mget(sql, "sticky_cwd"),
		overlay_version: mnum(sql, "overlay_version", 0),
		queue_depth: queueDepth(sql),
		last_seen_ms_ago: lastSeen === null ? null : Date.now() - lastSeen,
		failure_reason: mget(sql, "failure_reason"),
		commands,
		commands_truncated: commandsTruncated,
		disk_free_mb: diskFree,
		warnings,
	}
	if (!verbose) return base

	let facts: Record<string, unknown> = {}
	try {
		facts = JSON.parse(mget(sql, "facts") || "{}")
	} catch {
		facts = {}
	}
	return {
		...base,
		facts,
		agent_version: mget(sql, "agent_version"),
		env_overlay_preview: mget(sql, "overlay_preview"),
	}
}
