import { z } from "zod"
import type { BrokerConfig, Platform } from "./config"

/*
 * Tool input schemas.
 *
 * The MCP server validates arguments against these before the handler runs,
 * and returns an isError result the model can read when they do not match.
 * Handlers therefore receive well-typed values and do no shape checking.
 *
 * What is intentionally NOT here: numeric ranges. Every numeric field is
 * clamped by the handler, so encoding the range here would (a) reject values
 * the broker is perfectly happy to clamp and (b) put one limit in two places.
 * The clamp is still DOCUMENTED in every describe(), because a caller who
 * cannot see the floor cannot understand why max_bytes: 400 returned 999.
 */

export const ENV_ID_RE = /^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/

const ENV_ID_HELP =
	"Environment id returned by env_create, shaped like linux-a1b2c3d4, mac-a1b2c3d4 or win-a1b2c3d4. Call env_list if you do not have one."

const EnvIdField = z.string().regex(ENV_ID_RE, ENV_ID_HELP).describe(ENV_ID_HELP)

export const PlatformSchema = z.enum(["linux", "macos", "windows"])

/** Fails typecheck if config gains a platform this enum does not list. */
type PlatformsCovered = Exclude<Platform, z.infer<typeof PlatformSchema>> extends never ? true : never
const platformsCovered: PlatformsCovered = true
void platformsCovered

/* ------------------------------------------------------------------- env_* */

export function envCreateInput(cfg: BrokerConfig) {
	return z.strictObject({
		platform: PlatformSchema.describe("linux | macos | windows"),
		ttl_minutes: z
			.number()
			.optional()
			.describe(
				`Lease length in minutes. Default ${cfg.defaultTtlMinutes}, clamped to ${cfg.maxTtlMinutes} because GitHub kills any job at 6 hours.`,
			),
		label: z.string().optional().describe("Short human label, shown in env_list."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"Wait for the runner to enroll before returning. Still returns within ~45s whether or not it became ready.",
			),
	})
}

export function envExtendInput(cfg: BrokerConfig) {
	return z.strictObject({
		env_id: EnvIdField,
		minutes: z
			.number()
			.describe(
				`Minutes to ADD to the lease it has now. This never shortens a lease, and it is clamped so the lease stays within ${cfg.maxTtlMinutes} minutes of when the environment was created.`,
			),
	})
}

export const EnvStatusInput = z.strictObject({
	env_id: EnvIdField,
	verbose: z
		.boolean()
		.optional()
		.describe("Include runner facts: node version, cpu count, memory, available shells, base64 recipes."),
	wait_ready_ms: z
		.number()
		.optional()
		.describe("Block until the state leaves 'provisioning'. Clamped to 45000. Use this right after env_create."),
})

export const EnvListInput = z.strictObject({})

export const EnvDestroyInput = z.strictObject({
	env_id: EnvIdField,
	force: z.boolean().optional().describe("Destroy even if another session created it."),
})

/* ------------------------------------------------------------------ exec_* */

const EnvValue = z.union([z.string(), z.number(), z.boolean()])

export const ExecInput = z.strictObject({
	env_id: EnvIdField,
	command: z
		.string()
		.regex(/\S/, "command must contain something other than whitespace")
		.describe("Shell source. Multiple lines are fine; it is written to a script file and run, not passed with -c."),
	shell: z
		.enum(["bash", "sh", "zsh", "pwsh", "cmd"])
		.optional()
		.describe(
			"Default: bash on linux and macos, pwsh on windows. env_status(verbose) lists what this runner actually has; asking for one it does not have is refused up front rather than silently substituted.",
		),
	cwd: z.string().optional().describe("Override the sticky cwd for this command only."),
	env: z
		.record(z.string(), EnvValue)
		.optional()
		.describe("Extra environment variables for this command. Non-string values are stringified."),
	stdin_b64: z
		.string()
		.optional()
		.describe(
			"Base64-encoded stdin. The RUNNER decodes it and gives the command the raw bytes on fd 0, so do not decode it again inside the command. To write a file byte-exactly: `cat > path` on posix, or `[Console]::In.ReadToEnd()` with Set-Content on pwsh.",
		),
	max_bytes: z
		.number()
		.optional()
		.describe(
			"Output bytes to return. Default 65536, max 262144, minimum 1024 -- anything smaller is raised to that floor and then cut back to the last whole line, so a tiny value still returns roughly a kilobyte.",
		),
	deadline_ms: z
		.number()
		.optional()
		.describe("How long to wait before returning partial output. Default 20000, max 45000."),
	idle_return_ms: z.number().optional().describe("Return early after this much silence. Default 1500."),
	timeout_s: z
		.number()
		.optional()
		.describe("Kill the command after this long. Default 3600, and further clamped to the remaining lease."),
	inactivity_kill_s: z.number().optional().describe("Kill after this much silence. Default 0, meaning never."),
	label: z.string().optional().describe("Short human label for env_status listings."),
	idempotency_key: z
		.string()
		.optional()
		.describe(
			"Dedupe key for retries of ONE call. A second exec with the same key returns the first command instead of running twice, but only while that command is still in flight (deadline_ms + 60s). Once it has finished, the same key starts a new command.",
		),
	allow_duplicate: z
		.boolean()
		.optional()
		.describe(
			"Bypass dedupe. Before using this on a command that came back 'lost', read its output: a precondition failure is permanent and will simply fail again.",
		),
	keep_raw: z.boolean().optional().describe("Keep the runner's output file after exit, for debugging."),
})

export const ExecReadInput = z.strictObject({
	env_id: EnvIdField,
	command_id: z.string().min(1).describe("command_id returned by exec."),
	from_byte: z
		.number()
		.optional()
		.describe("Byte offset to resume from. Pass next_byte from the previous call. Re-reading an old offset is safe."),
	max_bytes: z.number().optional().describe("Default 65536, max 262144, minimum 1024."),
	wait_ms: z.number().optional().describe("Default 20000, max 45000."),
	until: z
		.enum(["any_output", "exit"])
		.optional()
		.describe("'any_output' returns as soon as there is anything new; 'exit' waits for the command to finish. Default any_output."),
})

export const ExecKillInput = z.strictObject({
	env_id: EnvIdField,
	command_id: z
		.string()
		.min(1)
		.describe(
			"A command_id, or the literal string 'all'. 'all' is only accepted here -- it is not a command_id you can later pass to exec_read.",
		),
	signal: z.enum(["TERM", "KILL"]).optional().describe("Default TERM, which escalates to KILL after 3s."),
})

export type EnvCreateArgs = z.infer<ReturnType<typeof envCreateInput>>
export type EnvExtendArgs = z.infer<ReturnType<typeof envExtendInput>>
export type EnvStatusArgs = z.infer<typeof EnvStatusInput>
export type EnvDestroyArgs = z.infer<typeof EnvDestroyInput>
export type ExecArgs = z.infer<typeof ExecInput>
export type ExecReadArgs = z.infer<typeof ExecReadInput>
export type ExecKillArgs = z.infer<typeof ExecKillInput>
