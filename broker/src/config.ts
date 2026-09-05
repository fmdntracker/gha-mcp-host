/*
 * Broker configuration and the platform tables.
 *
 * There is deliberately no command deny list here. An earlier version had one,
 * justified not as a sandbox but as account survival -- block the shapes that
 * exfiltrate GITHUB_TOKEN or that look like mining, and hope that keeps the
 * GitHub account off the suspension list. It was removed because it cannot do
 * that job:
 *
 *   - It matched a string the caller fully controls, in a system whose entire
 *     purpose is to execute caller-supplied shell. Any pattern is one variable
 *     assignment, one base64, or one heredoc away from being bypassed, and the
 *     caller is not an adversary anyway -- it is the user's own agent.
 *   - It could not be tightened without breaking real builds. `*shutdown*`
 *     rejects a repository that merely mentions the word.
 *   - It taught the model that `deny_pattern` is a class of failure worth
 *     working around, which is the opposite of the intended effect.
 *
 * The controls that actually protect the account are elsewhere and are real:
 * the env_create rate cap in GuardDO, the dispatch circuit breaker that latches
 * on an account-level 403, and the TTL lease that stops a forgotten runner from
 * billing minutes to the 6h job limit.
 */

export type BrokerConfig = {
	owner: string
	repo: string
	ref: string
	defaultTtlMinutes: number
	maxTtlMinutes: number
	maxEnvCreatesPerHour: number
	/** Long-poll seconds handed to the runner. Must stay under the client cap. */
	agentWaitSeconds: number
	execWorkers: number
	/** How long the runner tolerates an unreachable broker before self-destructing. */
	unreachableLimitSeconds: number
	/**
	 * Per-command output ceiling, enforced by the runner at write time and sent
	 * to it in claimNext. The broker cannot enforce this: it only ever sees the
	 * ranges it asks for, and by the time a runaway writer has filled the disk
	 * the job is already lost. 256 MiB is chosen against the hosted runners'
	 * smallest disk (macOS and Windows ship ~14 GB free), not against anything
	 * the broker stores.
	 */
	defaultMaxOutputBytes: number
}

function n(v: unknown, d: number): number {
	const x = Number(v)
	return Number.isFinite(x) ? x : d
}

export function loadConfig(env: Record<string, unknown>): BrokerConfig {
	return {
		owner: String(env.GITHUB_OWNER || ""),
		repo: String(env.GITHUB_REPO || ""),
		ref: String(env.GITHUB_REF || "main"),
		defaultTtlMinutes: n(env.DEFAULT_TTL_MINUTES, 60),
		maxTtlMinutes: n(env.MAX_TTL_MINUTES, 330),
		maxEnvCreatesPerHour: n(env.MAX_ENV_CREATES_PER_HOUR, 10),
		agentWaitSeconds: n(env.AGENT_WAIT_SECONDS, 50),
		execWorkers: n(env.EXEC_WORKERS, 4),
		unreachableLimitSeconds: n(env.UNREACHABLE_LIMIT_SECONDS, 600),
		defaultMaxOutputBytes: n(env.MAX_OUTPUT_BYTES, 256 * 1024 * 1024),
	}
}

export const PLATFORMS = ["linux", "macos", "windows"] as const
export type Platform = (typeof PLATFORMS)[number]

export const WORKFLOW_FOR: Record<Platform, string> = {
	linux: "linux.yml",
	macos: "macos.yml",
	windows: "windows.yml",
}

export const ID_PREFIX: Record<Platform, string> = {
	linux: "linux",
	macos: "mac",
	windows: "win",
}

/**
 * Platform-specific canonical commands, so the AI never has to invent them.
 *
 * The flags are not interchangeable and getting them wrong is a silent
 * corruption rather than an error: GNU coreutils wraps at 76 columns unless
 * told `-w0`, and BSD base64 on macOS spells the same thing `-b 0`. Both
 * accept `-d` to decode on current macOS, but `-D` is the spelling that has
 * always worked there.
 */
export const BASE64_RECIPES: Record<Platform, { encode: string; decode: string }> = {
	linux: {
		encode: "base64 -w0 <FILE>",
		decode: "base64 -d > <FILE>   # feed via stdin_b64",
	},
	macos: {
		encode: "base64 -b 0 -i <FILE>",
		decode: "base64 -D > <FILE>   # feed via stdin_b64",
	},
	windows: {
		encode: "[Convert]::ToBase64String([IO.File]::ReadAllBytes('<FILE>'))",
		decode: "[IO.File]::WriteAllBytes('<FILE>', [Convert]::FromBase64String($input))",
	},
}
