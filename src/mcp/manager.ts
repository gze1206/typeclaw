import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import type { McpServer } from '@/config/config'

import { connectMcpServer, type McpConnection } from './client'

const TOOL_NAMESPACE_SEPARATOR = '__'

export type McpConnectResult =
  | { ok: true; name: string; connection: McpConnection; toolCount: number }
  | { ok: false; name: string; error: Error }

export type McpRefreshResult = { ok: true; name: string; toolCount: number } | { ok: false; name: string; error: Error }

// Only ever 'needs-auth': the field's ABSENCE means "no auth failure seen", so a
// separate 'ok'/'unknown' state would be a synonym for undefined that every
// reader would have to handle twice.
export type McpServerAuthState = 'needs-auth'

export type McpServerInfo = {
  name: string
  description?: string
  connected: boolean
  toolCount?: number
  authState?: McpServerAuthState
}

export type McpManager = {
  connectAll(opts?: { signal?: AbortSignal }): Promise<McpConnectResult[]>
  ensureConnected(name: string): Promise<McpConnection | undefined>
  whenInitialConnectSettled(opts?: { timeoutMs?: number }): Promise<void>
  getConnection(name: string): McpConnection | undefined
  // The server's declared config, for callers that need policy (tool gating)
  // rather than connection state. Returns undefined for names that are not
  // configured or not enabled — the same visibility rule listServers uses.
  getServer(name: string): McpServer | undefined
  listServers(): McpServerInfo[]
  // Record that a call against this server failed for a reason re-authentication
  // would fix. A connected server can still be unauthenticated — tools/list is
  // public on many servers while tools/call is not — so connection state alone
  // cannot answer "can this server actually be used".
  markAuthFailure(name: string): void
  refresh(): Promise<McpRefreshResult[]>
  closeAll(): Promise<void>
}

export type ConnectMcpServerFn = (
  server: McpServer,
  opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal; authProvider?: OAuthClientProvider },
) => Promise<McpConnection>

export type McpAuthProviderFactory = (server: McpServer) => OAuthClientProvider | undefined

export function createMcpManager(
  servers: McpServer[],
  opts: { env: NodeJS.ProcessEnv; connect?: ConnectMcpServerFn; authProvider?: McpAuthProviderFactory },
): McpManager {
  const activeServers = servers.filter((server) => server.enabled)
  const connect = opts.connect ?? connectMcpServer
  const connections = new Map<string, McpConnection>()
  const toolCounts = new Map<string, number>()
  const authFailures = new Set<string>()
  // In-flight connect promises keyed by server name. Shared by connectAll (boot
  // warm-up) and ensureConnected (lazy, on a tool call) so a tool call racing
  // the warm-up — or two concurrent tool calls — coalesce onto one connect
  // attempt instead of spawning the server twice. connectServer stores the
  // connection on success and clears the entry once settled.
  const inflight = new Map<string, Promise<McpConnectResult>>()
  // The first connectAll() (the boot warm-up). whenInitialConnectSettled awaits
  // it so the catalog render can wait out the warm-up window.
  let initialConnect: Promise<McpConnectResult[]> | null = null
  // Shutdown latch. Because the boot warm-up runs un-awaited, closeAll() can
  // return while a connect is still in flight; without this, that late attempt
  // would cache (and never close) a live connection on an already-closed
  // manager. Once set, a resolving attempt closes its connection instead of
  // caching it, and new ensureConnected() calls are refused.
  let closed = false

  function connectServer(server: McpServer, signal: AbortSignal | undefined): Promise<McpConnectResult> {
    const established = connections.get(server.name)
    if (established !== undefined) {
      return Promise.resolve({
        ok: true,
        name: server.name,
        connection: established,
        toolCount: toolCounts.get(server.name) ?? 0,
      })
    }
    const pending = inflight.get(server.name)
    if (pending !== undefined) return pending

    const attempt = connectOne(server, opts.env, connect, signal, opts.authProvider?.(server)).then(async (result) => {
      inflight.delete(server.name)
      if (result.ok) {
        if (closed) {
          await result.connection.close().catch(() => {})
        } else {
          connections.set(result.name, result.connection)
          toolCounts.set(result.name, result.toolCount)
        }
      }
      return result
    })
    inflight.set(server.name, attempt)
    return attempt
  }

  return {
    async connectAll(connectOpts: { signal?: AbortSignal } = {}): Promise<McpConnectResult[]> {
      const firstIndexByName = new Map<string, number>()
      const attempt = Promise.all(
        activeServers.map((server, index): Promise<McpConnectResult> => {
          // The name is the tool namespace and the connections key, so a second
          // server sharing a name would silently shadow the first. Fail the
          // duplicate fast instead of connecting it, keeping routing unambiguous.
          const firstIndex = firstIndexByName.get(server.name)
          if (firstIndex !== undefined) {
            return Promise.resolve({
              ok: false,
              name: server.name,
              error: new Error(
                `mcpServers[${index}].name duplicates mcpServers[${firstIndex}].name ('${server.name}')`,
              ),
            })
          }
          firstIndexByName.set(server.name, index)
          return connectServer(server, connectOpts.signal)
        }),
      )
      initialConnect ??= attempt
      return attempt
    },
    async ensureConnected(name: string): Promise<McpConnection | undefined> {
      if (closed) return undefined
      const established = connections.get(name)
      if (established !== undefined) return established
      const server = activeServers.find((candidate) => candidate.name === name)
      if (server === undefined) return undefined
      const result = await connectServer(server, undefined)
      return result.ok ? result.connection : undefined
    },
    async whenInitialConnectSettled(readinessOpts: { timeoutMs?: number } = {}): Promise<void> {
      if (initialConnect === null) return
      const settled = initialConnect.then(
        () => {},
        () => {},
      )
      // No timeout (the catalog-render default) means await the real connectAll
      // settle. A fixed cap can't be correct here: a server is cached only after
      // connect() THEN the FULL paginated listTools(), whose total time is bounded
      // only by the server's own per-phase deadlines (connect timeout + a
      // configurable, up-to-10min request timeout, times the number of cursor
      // pages). Any fixed bound would silently drop a healthy slow/paginated
      // server from the first catalog. connectAll settles on its own per those
      // deadlines; infinite pagination is a pre-existing connectAll liveness risk,
      // not introduced here. An explicit timeoutMs is honored for tests/callers.
      const timeoutMs = readinessOpts.timeoutMs
      if (timeoutMs === undefined || timeoutMs <= 0) {
        await settled
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
      try {
        await Promise.race([settled, timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    getConnection(name: string): McpConnection | undefined {
      return connections.get(name)
    },
    getServer(name: string): McpServer | undefined {
      return activeServers.find((server) => server.name === name)
    },
    listServers(): McpServerInfo[] {
      return activeServers.map((server) => {
        const toolCount = toolCounts.get(server.name)
        return {
          name: server.name,
          connected: connections.has(server.name),
          ...(server.description === undefined ? {} : { description: server.description }),
          ...(toolCount === undefined ? {} : { toolCount }),
          ...(authFailures.has(server.name) ? { authState: 'needs-auth' as const } : {}),
        }
      })
    },
    markAuthFailure(name: string): void {
      // Ignore names that aren't configured/enabled, so a stale or mistyped name
      // can't invent a server that listServers would never report.
      if (!activeServers.some((server) => server.name === name)) return
      authFailures.add(name)
    },
    async refresh(): Promise<McpRefreshResult[]> {
      // One unhealthy connection must not discard healthy servers' tool-count
      // updates, so each refresh is isolated and reported per-server instead of
      // letting a single rejection fail the whole batch.
      return Promise.all(
        [...connections.entries()].map(async ([name, connection]): Promise<McpRefreshResult> => {
          try {
            const tools = await connection.refresh()
            toolCounts.set(name, tools.length)
            return { ok: true, name, toolCount: tools.length }
          } catch (cause) {
            return { ok: false, name, error: normalizeError(cause) }
          }
        }),
      )
    },
    async closeAll(): Promise<void> {
      // Latch shutdown first so any connect still in flight (the un-awaited boot
      // warm-up) closes its own connection on resolve instead of caching it.
      closed = true
      await Promise.allSettled([...connections.values()].map((connection) => connection.close()))
      connections.clear()
      toolCounts.clear()
      authFailures.clear()
      inflight.clear()
      initialConnect = null
    },
  }
}

export function namespaceToolName(server: string, tool: string): string {
  return `${server}${TOOL_NAMESPACE_SEPARATOR}${tool}`
}

export function parseNamespacedTool(namespaced: string): { server: string; tool: string } | undefined {
  // Config validation reserves `__` out of server names; splitting on the first
  // separator is therefore unambiguous even when MCP tool names contain it.
  const separatorIndex = namespaced.indexOf(TOOL_NAMESPACE_SEPARATOR)
  if (separatorIndex <= 0) return undefined

  const toolStart = separatorIndex + TOOL_NAMESPACE_SEPARATOR.length
  if (toolStart >= namespaced.length) return undefined

  return { server: namespaced.slice(0, separatorIndex), tool: namespaced.slice(toolStart) }
}

async function connectOne(
  server: McpServer,
  env: NodeJS.ProcessEnv,
  connect: ConnectMcpServerFn,
  signal: AbortSignal | undefined,
  authProvider: OAuthClientProvider | undefined,
): Promise<McpConnectResult> {
  let connection: McpConnection | undefined
  try {
    connection = await connect(server, { env, signal, authProvider })
    const tools = await connection.listTools()
    return { ok: true, name: server.name, connection, toolCount: tools.length }
  } catch (cause) {
    const closeError = connection === undefined ? undefined : await closeAfterFailedCatalog(connection)
    if (closeError !== undefined) {
      return {
        ok: false,
        name: server.name,
        error: new Error(`MCP server "${server.name}" failed to connect and then failed to close`, {
          cause: { original: cause, close: closeError },
        }),
      }
    }
    return { ok: false, name: server.name, error: normalizeError(cause) }
  }
}

async function closeAfterFailedCatalog(connection: McpConnection): Promise<Error | undefined> {
  try {
    await connection.close()
    return undefined
  } catch (cause) {
    return normalizeError(cause)
  }
}

function normalizeError(cause: unknown): Error {
  if (cause instanceof Error) return cause
  return new Error(String(cause))
}
