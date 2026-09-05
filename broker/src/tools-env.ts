import { BASE64_RECIPES, WORKFLOW_FOR, type BrokerConfig } from "./config"
import { cancelRun, dispatchWorkflow, listLiveRuns } from "./github"
import type { ToolDef } from "./mcp"
import { Deadline, SOFT_CAP_MS, clamp, fail, numArg, ok } from "./result"
import {
	ENV_ID_RE,
	EnvDestroyInput,
	EnvListInput,
	EnvStatusInput,
	envCreateInput,
	envExtendInput,
	type EnvCreateArgs,
	type EnvDestroyArgs,
	type EnvExtendArgs,
	type EnvStatusArgs,
} from "./schemas"
import { type Bindings, envStub, guard, newEnvId, platformOf, tryCall } from "./tools-shared"

export function buildEnvTools(env: Bindings, cfg: BrokerConfig): ToolDef[] {
	/* ------------------------------------------------------------ env_create */
	const envCreate: ToolDef = {
		name: "env_create",
		title: "Create a runner environment",
		description:
			"Dispatch a GitHub Actions job and return an env_id you pass to every other tool. " +
			"Returns immediately with state 'provisioning' unless wait is true; a runner normally becomes ready in 20-60s (linux), 40-120s (windows), 60-180s (macos). " +
			"Several environments can be live at once; they are fully independent, and each has its own env_id.",
		inputSchema: envCreateInput(cfg),
		async handler(args: EnvCreateArgs, ctx) {
			const platform = args.platform
			const g = guard(env)

			const breaker = await g.breaker()
			if (breaker.open) {
				return fail("account_suspended", breaker.message || "dispatch circuit breaker is open", {
					hint:
						"The breaker opened because GitHub returned an account-level 403. Repeated dispatching makes this worse and there is no self-service recovery. Ask the human to check GitHub Support before resetting it.",
					next_action: "stop and tell the user",
					extra: { breaker_since: breaker.since, breaker_code: breaker.code },
				})
			}

			const rate = await g.allowEnvCreate(cfg.maxEnvCreatesPerHour)
			if (!rate.allowed) {
				return fail("rate_capped", `env_create is capped at ${rate.max} per hour (used ${rate.used})`, {
					retry_after_ms: rate.retryAfterMs,
					hint: "reuse a live environment from env_list instead of creating another",
					next_action: "env_list",
				})
			}

			const ttl = clamp(numArg(args.ttl_minutes, cfg.defaultTtlMinutes), 5, cfg.maxTtlMinutes)
			const envId = newEnvId(platform)
			const stub = envStub(env, envId)
			await stub.provision({
				envId,
				platform,
				ttlMinutes: ttl,
				label: args.label ? args.label.slice(0, 64) : null,
				createdBy: null,
			})

			ctx.note(`dispatching a ${platform} runner`)
			const d = await dispatchWorkflow({
				token: String(env.GITHUB_PAT_DISPATCH || ""),
				owner: cfg.owner,
				repo: cfg.repo,
				workflow: WORKFLOW_FOR[platform],
				ref: cfg.ref,
				inputs: { env_id: envId, ttl_minutes: String(ttl) },
			})

			if (!d.ok) {
				// A failed dispatch must not burn hourly quota, and must not leave a
				// phantom `provisioning` row for the next env_list to trip over.
				await g.refundEnvCreate()
				await stub.markFailed(`${d.code}: ${d.message}`)
				if (d.code === "account_suspended") await g.trip(d.code, d.message)
				return fail(d.code, d.message, {
					retry_after_ms: d.retryAfterMs,
					extra: { env_id: envId, http_status: d.status },
					hint:
						d.code === "account_suspended"
							? "Stop. This is an account-level block with no timed recovery; every retry deepens it."
							: null,
				})
			}
			await stub.setDispatch({ runId: d.runId, runAttempt: d.runAttempt, runUrl: d.runUrl })

			let snap = await stub.snapshot(false)
			if (args.wait) {
				const dl = new Deadline(SOFT_CAP_MS, ctx.signal)
				while (snap.state === "provisioning" && (await dl.tick(1500))) {
					ctx.note(`waiting for the ${platform} runner to enroll`)
					snap = await stub.snapshot(false)
				}
			}

			const ready = snap.state === "ready"
			return ok(
				{
					env_id: envId,
					platform,
					state: snap.state,
					expires_at: snap.expires_at,
					ttl_minutes: ttl,
					run_url: d.runUrl,
					run_id: d.runId,
					env_creates_used_this_hour: rate.used,
					env_creates_per_hour: rate.max,
					base64_recipes: BASE64_RECIPES[platform],
				},
				{
					hint: ready ? null : "the Actions job is queued; nothing is wrong yet. macOS queues longest.",
					next_action: ready
						? `exec(env_id: "${envId}", command: "uname -a")`
						: `env_status(env_id: "${envId}", wait_ready_ms: 45000)`,
				},
			)
		},
	}

	/* ------------------------------------------------------------ env_status */
	const envStatus: ToolDef = {
		name: "env_status",
		title: "Inspect one environment",
		description:
			"State, remaining lease, sticky cwd, queue depth, recent commands and disk space. " +
			"Use wait_ready_ms right after env_create to block until the runner enrolls. " +
			"verbose also reports which shells this runner actually has, which is worth checking before passing shell: 'pwsh'.",
		inputSchema: EnvStatusInput,
		readOnly: true,
		async handler(args: EnvStatusArgs, ctx) {
			const envId = args.env_id
			const stub = envStub(env, envId)
			const verbose = Boolean(args.verbose)
			let snap = await stub.snapshot(verbose)
			if (!snap.env_id) {
				return fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" })
			}
			const waitMs = clamp(numArg(args.wait_ready_ms, 0), 0, SOFT_CAP_MS)
			if (waitMs > 0) {
				const dl = new Deadline(waitMs, ctx.signal)
				while (snap.state === "provisioning" && (await dl.tick(1500))) {
					ctx.note("waiting for the runner to enroll")
					snap = await stub.snapshot(verbose)
				}
			}
			const platform = platformOf(envId)
			return ok(
				{ ...snap, base64_recipes: verbose ? BASE64_RECIPES[platform] : undefined },
				{
					warnings: (snap.warnings as string[]) || [],
					hint:
						snap.state === "provisioning"
							? "still queueing on GitHub's side; this is normal, especially for macos"
							: snap.state === "failed"
								? String(snap.failure_reason || "dispatch or enroll failed")
								: null,
					next_action:
						snap.state === "ready" ? "exec" : snap.state === "provisioning" ? "env_status" : "env_create",
				},
			)
		},
	}

	/* -------------------------------------------------------------- env_list */
	const envList: ToolDef = {
		name: "env_list",
		title: "List live environments",
		description:
			"Derived from GitHub's queued and in-progress workflow runs, so it cannot show environments that no longer exist. " +
			"Prefer reusing one of these over env_create: creates are rate-capped and a cold runner costs a minute you do not have to spend.",
		inputSchema: EnvListInput,
		readOnly: true,
		async handler(_args, ctx) {
			ctx.note("listing live Actions runs")
			const live = await listLiveRuns({
				token: String(env.GITHUB_PAT_DISPATCH || ""),
				owner: cfg.owner,
				repo: cfg.repo,
			})
			if (!live.ok) return fail(live.code, live.message, { retry_after_ms: live.retryAfterMs })

			const envs: unknown[] = []
			for (const run of live.runs) {
				const m = ENV_ID_RE.exec(run.name) ?? /(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}/.exec(run.name)
				if (!m) continue
				const envId = m[0]
				const r = await tryCall(() => envStub(env, envId).snapshot(false))
				envs.push({
					env_id: envId,
					platform: platformOf(envId),
					run_status: run.status,
					run_url: run.html_url,
					state: r.value?.state ?? "lost",
					label: r.value?.label ?? null,
					expires_at: r.value?.expires_at ?? null,
					ttl_remaining_s: r.value?.ttl_remaining_s ?? null,
					queue_depth: r.value?.queue_depth ?? null,
				})
			}
			return ok(
				{ environments: envs, count: envs.length },
				{
					hint: envs.length ? null : "nothing live; env_create one",
					next_action: envs.length ? "exec" : "env_create",
				},
			)
		},
	}

	/* ----------------------------------------------------------- env_destroy */
	const envDestroy: ToolDef = {
		name: "env_destroy",
		title: "Destroy an environment",
		description:
			"Tells the runner to self-destruct AND cancels the Actions run. Returns ok only once GitHub accepts the cancel, " +
			"because a runner that ignores the control channel would otherwise bill minutes until its 6h job limit.",
		inputSchema: EnvDestroyInput,
		async handler(args: EnvDestroyArgs, ctx) {
			const envId = args.env_id
			const stub = envStub(env, envId)
			const { run_id } = await stub.markDestroying()
			const warnings: string[] = []

			if (!run_id) {
				warnings.push(
					"no run id was recorded for this environment, so the Actions run could not be cancelled by API; the runner's own lease expiry and the job timeout are the remaining nets",
				)
				return ok({ env_id: envId, destroyed: true, cancel_status: null }, { warnings })
			}

			ctx.note("cancelling the Actions run")
			const c = await cancelRun({
				token: String(env.GITHUB_PAT_DISPATCH || ""),
				owner: cfg.owner,
				repo: cfg.repo,
				runId: run_id,
			})
			if (!c.ok) {
				return fail("github_5xx", `cancel not accepted: ${c.status} ${c.message}`, {
					retry_after_ms: 3000,
					extra: { env_id: envId, destroyed: true },
					hint: "the runner was told to self-destruct, but confirm with env_list that the run really stopped",
					next_action: "env_destroy",
				})
			}
			return ok({ env_id: envId, destroyed: true, cancel_status: c.status }, { warnings })
		},
	}

	/* ------------------------------------------------------------ env_extend */
	const envExtend: ToolDef = {
		name: "env_extend",
		title: "Extend the lease",
		description: `Push the lease out. Clamped to ${cfg.maxTtlMinutes} minutes from creation, since GitHub kills any job at 6 hours.`,
		inputSchema: envExtendInput(cfg),
		async handler(args: EnvExtendArgs) {
			const envId = args.env_id
			const minutes = clamp(numArg(args.minutes, 30), 1, cfg.maxTtlMinutes)
			const r = await envStub(env, envId).extend(minutes, cfg.maxTtlMinutes)
			return ok(
				{
					env_id: envId,
					expires_at: r.ttl_expires_at,
					ttl_remaining_s: Math.max(0, Math.floor((r.ttl_expires_at - Date.now()) / 1000)),
				},
				{ warnings: r.warnings },
			)
		},
	}

	return [envCreate, envStatus, envList, envDestroy, envExtend]
}
