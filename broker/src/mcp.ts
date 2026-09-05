import { McpServer } from "@modelcontextprotocol/server"
import type { ZodTypeAny } from "zod"

export const SERVER_INFO = { name: "gha-mcp", version: "0.2.0" }

/** How often to send notifications/progress while a tool is still working. */
export const PROGRESS_INTERVAL_MS = 5_000

export type ToolCtx = {
	/**
	 * Aborts when the client sends notifications/cancelled AND when the
	 * connection drops. Every polling loop in this Worker must respect it:
	 * without it, a client that gives up at the 60s protocol default leaves us
	 * polling a Durable Object to the 45s soft cap for nobody.
	 */
	signal: AbortSignal
	/**
	 * Set the message the progress heartbeat will report next. Cheap and
	 * fire-and-forget -- it does not send anything by itself, so a tool can call
	 * it on every poll iteration without adding a round trip.
	 */
	note: (message: string) => void
}

export type ToolDef = {
	name: string
	title: string
	description: string
	/** A Zod object schema. The SDK derives the advertised JSON Schema from it. */
	inputSchema: ZodTypeAny
	/** Sets readOnlyHint. Only true for tools that cannot change runner state. */
	readOnly?: boolean
	/**
	 * `args` is deliberately `any`. Every tool's handler takes the exact shape its
	 * own zod schema produces, and function parameters are contravariant under
	 * strictFunctionTypes: a handler declared to accept Record<string, any> is NOT
	 * assignable to one that requires { env_id: string, ... }. The SDK validates
	 * arguments against inputSchema before the handler runs and turns a mismatch
	 * into an isError result, so inputSchema -- not this type -- is where the
	 * validation boundary actually sits.
	 */
	handler: (args: any, ctx: ToolCtx) => Promise<Record<string, unknown>>
}

/**
 * Turn one of our `ok()` / `fail()` payloads into an MCP tool result.
 *
 * `ok: false` becomes `isError: true` rather than a thrown error, because a
 * thrown error surfaces to the client as a protocol failure and the whole
 * point of this project is that the model gets a readable, actionable result
 * instead of `MCP error -32001: Request timed out`.
 *
 * The payload is emitted twice on purpose: as `structuredContent` for callers
 * that can consume it, and as compact JSON text for callers that only read
 * `content`. Notion's client is in the second group today.
 *
 * NOTE ON outputSchema: not declared yet, deliberately. Declaring it would
 * make the SDK validate `structuredContent` before it leaves the server, which
 * is what we want -- but `ok()` and `fail()` return different key sets today,
 * so a single schema would have to be a union loose enough to validate nothing
 * useful. The fix is to give every tool one key set with every field always
 * present (the invariant exec/exec_read already follow) and then declare an
 * exact schema. That refactor plus outputSchema is M2; the zod major is no
 * longer an open question, since the build resolves zod 4.
 */
function toResult(payload: Record<string, unknown>) {
	const failed = payload.ok === false
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent: payload,
		...(failed ? { isError: true } : {}),
	}
}

function register(server: McpServer, def: ToolDef): void {
	server.registerTool(
		def.name,
		{
			description: def.description,
			inputSchema: def.inputSchema,
			annotations: {
				title: def.title,
				readOnlyHint: def.readOnly === true,
				// Every tool reaches a machine we do not control.
				openWorldHint: true,
			},
		},
		// args is unknown because inputSchema is a ZodTypeAny rather than a raw
		// shape; the SDK has already validated it against that schema by the time
		// this runs, and the handler's own parameter type documents what it is.
		async (args: unknown, ctx: any) => {
			const progressToken = ctx?.mcpReq?._meta?.progressToken
			const signal: AbortSignal = ctx?.mcpReq?.signal ?? new AbortController().signal

			let message = `${def.name} started`
			// progress must strictly increase for a given token, so it is a counter,
			// never a percentage: we genuinely cannot know the denominator for a
			// build that has not finished.
			let ticks = 0
			let timer: ReturnType<typeof setInterval> | undefined

			if (progressToken !== undefined && typeof ctx?.mcpReq?.notify === "function") {
				timer = setInterval(() => {
					ticks += 1
					const elapsed = ticks * Math.round(PROGRESS_INTERVAL_MS / 1000)
					Promise.resolve(
						ctx.mcpReq.notify({
							method: "notifications/progress",
							params: {
								progressToken,
								progress: ticks,
								message: `${message} (${elapsed}s)`,
							},
						}),
						// A failed heartbeat must never fail the tool. If the stream is
						// gone, the abort signal is the thing that should stop us.
					).catch(() => {})
				}, PROGRESS_INTERVAL_MS)
			}

			try {
				const payload = await def.handler(args, {
					signal,
					note: (m) => {
						message = m
					},
				})
				return toResult(payload)
			} catch (e: any) {
				// Last line of defence. An escaping throw would reach the client as a
				// protocol error with no command_id in it, which is unrecoverable for
				// the caller: it cannot tell whether the command started.
				return toResult({
					ok: false,
					error: {
						code: "broker_internal",
						message: String(e?.message ?? e).slice(0, 400),
					},
					on_error: "retry",
					retryable: true,
					retry_after_ms: 2000,
					warnings: [
						"the broker threw before the tool could report a result; if this was exec, a command may still be running -- check env_status before re-running anything that is not idempotent",
					],
					hint: null,
					next_action: "env_status",
				})
			} finally {
				if (timer) clearInterval(timer)
			}
		},
	)
}

/**
 * Build the factory that `createMcpHandler` calls once per request.
 *
 * It has to be a factory, not a shared instance: the handler creates one MCP
 * server per request because version, identity and capabilities travel with
 * every request in the stateless model. Our tools close over the Worker's
 * `env` bindings, so the handler itself is also constructed per request. That
 * is supported for ordinary tools; it would only be wrong if we used
 * `handler.notify` or `subscriptions/listen`, which we do not.
 */
export function serverFactory(tools: ToolDef[]): () => McpServer {
	return () => {
		const server = new McpServer(SERVER_INFO)
		for (const def of tools) register(server, def)
		return server
	}
}
