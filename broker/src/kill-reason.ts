/**
 * Why a command was killed, and which answer wins when more than one is true.
 *
 * The runner reports reasons in the order the operating system reveals them,
 * which is not the order of explanatory power. A command that fills the disk
 * stops producing output, then trips the inactivity timer, then fails to write:
 * three reports, one cause. Recording the first arrival would blame the timer.
 */
export const KILLED_REASONS = ["enospc", "output_cap", "timeout", "inactivity", "user", "spawn_gap"] as const

export type KilledReason = (typeof KILLED_REASONS)[number]

/**
 * Higher wins. Equal ranks keep whichever was recorded first.
 *
 * - `enospc` is set only when the agent's own write actually returned ENOSPC,
 *   never inferred from silence or from free-space readings. Because it is that
 *   narrow, it is never a guess, and it explains every other symptom -- so it
 *   outranks everything.
 * - `output_cap` is a policy kill the system chose deliberately. It is strictly
 *   more informative than the clock reason that follows from it.
 * - `timeout` and `inactivity` are the two clock kills and share a rank. They
 *   are mutually exclusive by construction: a command that produced nothing is
 *   always `inactivity`, never `timeout`.
 * - `user` loses to every policy reason on purpose. If a cap had already fired,
 *   "the user killed it" is true and useless.
 * - `spawn_gap` is an inference from a process that is not there, so any
 *   concrete reason beats it.
 */
const PRIORITY: Record<KilledReason, number> = {
	enospc: 60,
	output_cap: 50,
	timeout: 40,
	inactivity: 40,
	user: 20,
	spawn_gap: 10,
}

export function isKilledReason(v: unknown): v is KilledReason {
	return typeof v === "string" && (KILLED_REASONS as readonly string[]).includes(v)
}

/**
 * Merge a newly reported reason into what is already recorded.
 *
 * An unrecognised value is dropped rather than stored, with a warning: a
 * killed_reason outside the documented set would force every consumer to handle
 * an open string, which is how "state: unknown" got into the old system.
 */
export function pickKilledReason(
	existing: unknown,
	incoming: unknown,
): { reason: KilledReason | null; warning: string | null } {
	const current = isKilledReason(existing) ? existing : null

	if (incoming === null || incoming === undefined || incoming === "") {
		return { reason: current, warning: null }
	}
	if (!isKilledReason(incoming)) {
		return {
			reason: current,
			warning: `the runner reported an unknown killed_reason ${JSON.stringify(String(incoming))}; it was not recorded`,
		}
	}
	if (!current) return { reason: incoming, warning: null }
	return { reason: PRIORITY[incoming] > PRIORITY[current] ? incoming : current, warning: null }
}
