import { createMcpHandler as createSdkHandler } from "@modelcontextprotocol/server"

// The shared router uses the callable Agents SDK facade. Use the same MCP v2
// handler directly on Node, without pulling in Agents or a Workers emulator.
export function createMcpHandler(factory, { route: _route, ...options } = {}) {
  const handler = createSdkHandler(factory, { maxRequestBodySize: 16 * 1024 * 1024, ...options })
  return async (request) => {
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      request.signal.removeEventListener("abort", finish)
      void handler.close().catch(() => {})
    }
    request.signal.addEventListener("abort", finish, { once: true })
    if (request.signal.aborted) finish()
    try {
      const response = await handler.fetch(request)
      if (!response.body) {
        finish()
        return response
      }
      const reader = response.body.getReader()
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) { finish(); controller.close() }
            else controller.enqueue(value)
          } catch (error) { finish(); controller.error(error) }
        },
        async cancel(reason) {
          finish()
          await reader.cancel(reason).catch(() => {})
        },
      })
      // Do not close immediately after fetch(): progress notifications and the
      // final result may still be in flight on an SSE body.
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) { finish(); throw error }
  }
}
