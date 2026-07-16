import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, type CallToolResult, type ListToolsRequest } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'
import { resolveSecret, type Secret } from '@/secrets/resolve'

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: unknown
}

// The SDK defaults each request to 60s; typeclaw boot should fail fast enough
// that one dead MCP server does not make the agent feel hung at startup.
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000

export type McpConnection = {
  name: string
  listTools(): Promise<McpToolInfo[]>
  refresh(): Promise<McpToolInfo[]>
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

export type McpSdkClient = {
  listTools(
    params?: ListToolsRequest['params'],
    options?: RequestOptions,
  ): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[]
    nextCursor?: string
  }>
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: typeof CallToolResultSchema,
    options?: RequestOptions,
  ): Promise<CallToolResult>
  close(): Promise<void>
}

type McpConnectClient = McpSdkClient & {
  connect(transport: Transport, options?: RequestOptions): Promise<void>
}

export async function connectMcpServer(
  server: McpServer,
  opts: {
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    connectTimeoutMs?: number
    client?: McpConnectClient
    transport?: Transport
    authProvider?: OAuthClientProvider
  },
): Promise<McpConnection> {
  const requestTimeout = server.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS
  const connectTimeout = opts.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
  const client = opts.client ?? new Client({ name: 'typeclaw', version: '0.17.0' }, { capabilities: {} })
  const transport = opts.transport ?? createTransport(server, opts.env, opts.authProvider)

  try {
    await withConnectDeadline(connectTimeout, opts.signal, (signal) =>
      client.connect(transport, { signal, timeout: requestTimeout }),
    )
  } catch (cause) {
    try {
      await client.close()
    } catch (closeCause) {
      attachCloseCause(cause, closeCause)
    }
    throw cause
  }

  return createMcpConnection(
    server.name,
    {
      listTools: (params, options) => client.listTools(params, options),
      async callTool(params, _resultSchema, options) {
        const result = await client.callTool(params, CallToolResultSchema, options)
        return CallToolResultSchema.parse(result)
      },
      close: () => client.close(),
    },
    { timeoutMs: requestTimeout },
  )
}

export function createMcpConnection(
  name: string,
  client: McpSdkClient,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): McpConnection {
  let cachedTools: McpToolInfo[] | undefined
  const timeout = opts.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS

  async function fetchTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout,
        signal: opts.signal,
      })
      tools.push(
        ...result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        })),
      )
      cursor = result.nextCursor
    } while (cursor !== undefined)

    cachedTools = tools
    return cachedTools
  }

  return {
    name,
    async listTools(): Promise<McpToolInfo[]> {
      if (cachedTools !== undefined) return cachedTools
      return fetchTools()
    },
    refresh(): Promise<McpToolInfo[]> {
      cachedTools = undefined
      return fetchTools()
    },
    callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      return client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
        timeout,
        signal: opts.signal,
      })
    },
    close(): Promise<void> {
      return client.close()
    },
  }
}

export function createTransport(
  server: McpServer,
  env: NodeJS.ProcessEnv,
  authProvider?: OAuthClientProvider,
): Transport {
  if (server.command) {
    return new StdioClientTransport({ command: server.command, args: server.args, env: resolveServerEnv(server, env) })
  }
  const url = new URL(requiredUrl(server))
  const headers = resolveServerHeaders(server, env)
  const hasHeaders = Object.keys(headers).length > 0
  if (authProvider === undefined && !hasHeaders) return new StreamableHTTPClientTransport(url)
  return new StreamableHTTPClientTransport(url, {
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(hasHeaders ? { requestInit: { headers } } : {}),
  })
}

async function withConnectDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('MCP connect timeout')), timeoutMs)
  const merged = mergeSignals(parentSignal, deadline.signal)
  const operation = fn(merged.signal)
  let removeAbortListener = (): void => {}
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(merged.signal.reason)
    removeAbortListener = (): void => merged.signal.removeEventListener('abort', onAbort)
    if (merged.signal.aborted) onAbort()
    else merged.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, abort])
  } finally {
    clearTimeout(timer)
    removeAbortListener()
    if (merged.signal.aborted) void operation.catch(() => undefined)
    merged.dispose()
  }
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (activeSignals.length === 0) return { signal: new AbortController().signal, dispose() {} }
  if (activeSignals.length === 1) return { signal: activeSignals[0]!, dispose() {} }

  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of activeSignals) {
    const abort = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const remove of listeners) remove()
    },
  }
}

function attachCloseCause(cause: unknown, closeCause: unknown): void {
  if (!(cause instanceof Error)) return
  const error = cause as Error & { cause?: unknown }
  error.cause = { original: error.cause, close: closeCause }
}

// A stdio MCP server is a child process the agent spawns, so it must NOT
// inherit the full parent environment: that env holds unrelated credentials
// (OPENAI_API_KEY, GH_TOKEN, channel tokens) and inheriting them leaks every
// secret to every server. We start from a minimal allowlist needed to spawn and
// run a process (PATH/HOME to launch npx/bunx, locale + temp for correctness),
// then overlay only the secrets the server explicitly declares. This mirrors
// the bwrap sandbox's `--clearenv` + DEFAULT_SANDBOX_ENV leak guard.
const BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const

export function resolveServerEnv(server: Pick<McpServer, 'env'>, env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv: Record<string, string> = {}
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }

  for (const [key, secret] of Object.entries(server.env)) {
    const explicitKeyValue = env[key]
    const resolved =
      explicitKeyValue !== undefined && explicitKeyValue !== '' ? explicitKeyValue : resolveSecret(secret, key, env)
    if (resolved !== undefined) childEnv[key] = resolved
  }

  return childEnv
}

// Whether the server already authenticates itself via a static Authorization
// header, making an OAuth provider redundant. Only the Authorization header
// counts: the SDK overwrites exactly that header when a provider is attached, so
// pairing the two is contradictory. Other custom headers (tenant routing,
// tracing) coexist with OAuth and must NOT suppress the provider.
export function usesStaticAuthorization(server: Pick<McpServer, 'headers' | 'bearerToken'>): boolean {
  if (server.bearerToken !== undefined) return true
  return Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
}

// Static HTTP auth for servers that authenticate with an API key rather than
// OAuth — the majority of the HTTP MCP ecosystem today.
//
// Two deliberate departures from resolveServerEnv:
//
//  1. NO env-wins override on the map key. There, keys ARE env var names, so
//     `env[key]` is the same namespace. A header key is an HTTP field name; it
//     shares nothing with the process env, and honouring `env['X-API-Key']`
//     would let an unrelated ambient variable silently become a credential.
//     Reading the env stays explicit, via a `{ env: '...' }` Secret.
//  2. An unresolvable header THROWS instead of being dropped. An absent env
//     var is a missing credential, and headers are the credential here — a
//     silent omission surfaces later as an opaque 401 with nothing pointing
//     back at the typo.
export function resolveServerHeaders(
  server: Pick<McpServer, 'name' | 'headers' | 'bearerToken'>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const [name, secret] of Object.entries(server.headers ?? {})) {
    headers[name] = resolveHeaderSecret(server.name, name, secret, env)
  }

  if (server.bearerToken !== undefined) {
    // Config validation rejects bearerToken alongside any Authorization header,
    // so this never overwrites an operator-set value.
    headers.Authorization = `Bearer ${resolveHeaderSecret(server.name, 'bearerToken', server.bearerToken, env)}`
  }

  return headers
}

function resolveHeaderSecret(serverName: string, field: string, secret: Secret, env: NodeJS.ProcessEnv): string {
  const resolved = resolveSecret(secret, undefined, env)
  if (resolved === undefined || resolved === '') {
    // Names the field, never the value: this message reaches logs and the model.
    throw new Error(`MCP server "${serverName}" ${field} could not be resolved; set its value or export its env var`)
  }
  return resolved
}

function requiredUrl(server: McpServer): string {
  if (server.url !== undefined) return server.url
  throw new Error(`MCP server "${server.name}" is missing url`)
}
