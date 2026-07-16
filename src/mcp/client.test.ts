import { describe, expect, test } from 'bun:test'

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@/config/config'

import {
  connectMcpServer,
  createMcpConnection,
  createTransport,
  resolveServerEnv,
  resolveServerHeaders,
  usesStaticAuthorization,
  type McpSdkClient,
} from './client'

describe('resolveServerEnv', () => {
  test('uses target env key before explicit secret env before secret value', () => {
    const server: Pick<McpServer, 'env'> = {
      env: {
        TARGET_TOKEN: { env: 'SOURCE_TOKEN', value: 'from-file' },
        SOURCE_ONLY: { env: 'SOURCE_ONLY_ENV', value: 'from-file-source' },
        FILE_ONLY: { value: 'from-file-only' },
      },
    }

    const resolved = resolveServerEnv(server, {
      TARGET_TOKEN: 'from-target-env',
      SOURCE_TOKEN: 'from-source-env',
      SOURCE_ONLY_ENV: 'from-source-only-env',
    })

    expect(resolved.TARGET_TOKEN).toBe('from-target-env')
    expect(resolved.SOURCE_ONLY).toBe('from-source-only-env')
    expect(resolved.FILE_ONLY).toBe('from-file-only')
  })

  test('forwards only allowlisted base env, never undeclared secrets', () => {
    const server: Pick<McpServer, 'env'> = { env: { DECLARED_TOKEN: { env: 'DECLARED_SOURCE' } } }

    const resolved = resolveServerEnv(server, {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      OPENAI_API_KEY: 'sk-secret',
      GH_TOKEN: 'ghp-secret',
      FIREWORKS_API_KEY: 'fw-secret',
      DECLARED_SOURCE: 'declared-value',
    })

    expect(resolved.PATH).toBe('/usr/bin')
    expect(resolved.HOME).toBe('/home/agent')
    expect(resolved.DECLARED_TOKEN).toBe('declared-value')
    expect(resolved.OPENAI_API_KEY).toBeUndefined()
    expect(resolved.GH_TOKEN).toBeUndefined()
    expect(resolved.FIREWORKS_API_KEY).toBeUndefined()
  })
})

describe('McpConnection', () => {
  test('caches listed tools after the first catalog load', async () => {
    let listCalls = 0
    const callResult: CallToolResult = { content: [{ type: 'text', text: 'ok' }] }
    const client: McpSdkClient = {
      async listTools(_params, _options) {
        listCalls += 1
        return { tools: [{ name: 'first', inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, _options) {
        return callResult
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client)

    const first = await connection.listTools()
    const second = await connection.listTools()

    expect(first).toEqual([{ name: 'first', description: '', inputSchema: { type: 'object' } }])
    expect(second).toBe(first)
    expect(listCalls).toBe(1)
  })

  test('refresh clears the cached catalog before fetching again', async () => {
    let listCalls = 0
    const client: McpSdkClient = {
      async listTools(_params, _options) {
        listCalls += 1
        return { tools: [{ name: `tool-${listCalls}`, inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, _options) {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client)

    const first = await connection.listTools()
    const refreshed = await connection.refresh()
    const afterRefresh = await connection.listTools()

    expect(first[0]?.name).toBe('tool-1')
    expect(refreshed[0]?.name).toBe('tool-2')
    expect(afterRefresh).toBe(refreshed)
    expect(listCalls).toBe(2)
  })

  test('forwards explicit request timeouts to listTools and callTool', async () => {
    const options: RequestOptions[] = []
    const client: McpSdkClient = {
      async listTools(_params, option) {
        if (option !== undefined) options.push(option)
        return { tools: [{ name: 'first', inputSchema: { type: 'object' } }] }
      },
      async callTool(_params, _resultSchema, option) {
        if (option !== undefined) options.push(option)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      async close() {},
    }
    const connection = createMcpConnection('server', client, { timeoutMs: 123 })

    await connection.listTools()
    await connection.callTool('first')

    expect(options.map((option) => option.timeout)).toEqual([123, 123])
  })
})

describe('connectMcpServer', () => {
  test('rejects when client.connect does not settle before the connect deadline', async () => {
    let closeCalls = 0
    const client = fakeConnectClient({
      async connect(_transport, options) {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      },
      async close() {
        closeCalls += 1
      },
    })

    await expect(
      connectMcpServer(server(), { env: {}, client, transport: fakeTransport(), connectTimeoutMs: 20 }),
    ).rejects.toThrow(/connect timeout/)
    expect(closeCalls).toBe(1)
  })

  test('closes a partially-started client and preserves the original connect error', async () => {
    const connectError = new Error('initialize failed')
    let closeCalls = 0
    const client = fakeConnectClient({
      async connect() {
        throw connectError
      },
      async close() {
        closeCalls += 1
      },
    })

    await expect(
      connectMcpServer(server(), { env: {}, client, transport: fakeTransport(), connectTimeoutMs: 20 }),
    ).rejects.toBe(connectError)
    expect(closeCalls).toBe(1)
  })
})

describe('resolveServerHeaders', () => {
  test('resolves literal header values', () => {
    const resolved = resolveServerHeaders({ name: 'acme', headers: { 'X-API-Key': { value: 'literal-key' } } }, {})

    expect(resolved).toEqual({ 'X-API-Key': 'literal-key' })
  })

  test('resolves an env-referencing header value from the process env', () => {
    const resolved = resolveServerHeaders(
      { name: 'acme', headers: { 'X-API-Key': { env: 'ACME_KEY' } } },
      {
        ACME_KEY: 'from-env',
      },
    )

    expect(resolved).toEqual({ 'X-API-Key': 'from-env' })
  })

  test('desugars bearerToken into an Authorization header', () => {
    const resolved = resolveServerHeaders({ name: 'linear', headers: {}, bearerToken: { value: 'tok-123' } }, {})

    expect(resolved).toEqual({ Authorization: 'Bearer tok-123' })
  })

  test('desugars an env-referencing bearerToken', () => {
    const resolved = resolveServerHeaders(
      { name: 'linear', headers: {}, bearerToken: { env: 'LINEAR_TOKEN' } },
      {
        LINEAR_TOKEN: 'tok-env',
      },
    )

    expect(resolved).toEqual({ Authorization: 'Bearer tok-env' })
  })

  test('does not read the process env under the raw header name', () => {
    // Deliberate asymmetry with resolveServerEnv, whose keys ARE env var names
    // and so get an env-wins override. A header name is an HTTP field name; it
    // shares no namespace with the process env, and honouring it would let an
    // unrelated ambient variable silently become a credential.
    const resolved = resolveServerHeaders(
      { name: 'acme', headers: { 'X-API-Key': { value: 'from-config' } } },
      {
        'X-API-Key': 'from-ambient-env',
      },
    )

    expect(resolved).toEqual({ 'X-API-Key': 'from-config' })
  })

  test('throws without leaking the secret when a header cannot be resolved', () => {
    // Headers ARE the credential here, so dropping an unresolved one silently
    // turns a config typo into an opaque 401 at call time.
    const call = (): Record<string, string> =>
      resolveServerHeaders({ name: 'acme', headers: { 'X-API-Key': { env: 'MISSING_KEY' } } }, {})

    expect(call).toThrow(/X-API-Key/)
    expect(call).toThrow(/acme/)
  })

  test('returns an empty object when no headers or bearerToken are configured', () => {
    expect(resolveServerHeaders({ name: 'acme', headers: {} }, {})).toEqual({})
  })
})

describe('usesStaticAuthorization', () => {
  test('is true for a bearerToken server', () => {
    expect(usesStaticAuthorization({ ...httpServer(), bearerToken: { value: 'tok' } })).toBe(true)
  })

  test('is true for a server that sets its own Authorization header, in any case', () => {
    expect(usesStaticAuthorization({ ...httpServer(), headers: { Authorization: { value: 'Bearer x' } } })).toBe(true)
    expect(usesStaticAuthorization({ ...httpServer(), headers: { authorization: { value: 'Bearer x' } } })).toBe(true)
  })

  test('is false for a server whose headers carry no Authorization', () => {
    // A non-Authorization header legitimately coexists with OAuth (tenant
    // routing, tracing), so it must not suppress the auth provider.
    expect(usesStaticAuthorization({ ...httpServer(), headers: { 'X-Tenant': { value: 'acme' } } })).toBe(false)
  })

  test('is false for a plain http server', () => {
    expect(usesStaticAuthorization(httpServer())).toBe(false)
  })
})

describe('createTransport', () => {
  test('attaches an auth provider only for HTTP servers when one is provided', () => {
    const authProvider = fakeAuthProvider()

    const withAuth = createTransport(httpServer(), {}, authProvider)
    const bare = createTransport(httpServer(), {})
    const stdio = createTransport(server(), {}, authProvider)

    expect(objectGraphContains(withAuth, authProvider)).toBe(true)
    expect(objectGraphContains(bare, authProvider)).toBe(false)
    expect(objectGraphContains(stdio, authProvider)).toBe(false)
  })

  test('passes resolved headers to the HTTP transport as requestInit headers', () => {
    const transport = createTransport(
      { ...httpServer(), headers: { 'X-API-Key': { env: 'ACME_KEY' } } },
      {
        ACME_KEY: 'from-env',
      },
    )

    expect(findRequestInitHeaders(transport)).toEqual({ 'X-API-Key': 'from-env' })
  })

  test('desugars bearerToken onto the HTTP transport', () => {
    const transport = createTransport({ ...httpServer(), bearerToken: { value: 'tok-123' } }, {})

    expect(findRequestInitHeaders(transport)).toEqual({ Authorization: 'Bearer tok-123' })
  })

  test('sends no custom headers when none are configured', () => {
    expect(findRequestInitHeaders(createTransport(httpServer(), {}))).toBeUndefined()
  })
})

function server(timeoutMs?: number): McpServer {
  return {
    name: 'server',
    enabled: true,
    command: 'server-command',
    args: [],
    env: {},
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function httpServer(): McpServer {
  return {
    name: 'server',
    enabled: true,
    url: 'https://mcp.example.com/mcp',
    args: [],
    env: {},
  }
}

function fakeAuthProvider(): OAuthClientProvider {
  return {
    redirectUrl: 'http://localhost:1456/callback',
    clientMetadata: {
      client_name: 'typeclaw',
      redirect_uris: ['http://localhost:1456/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientInformation() {
      return undefined
    },
    tokens() {
      return undefined
    },
    async saveTokens(_tokens) {},
    async redirectToAuthorization(_url) {},
    async saveCodeVerifier(_verifier) {},
    codeVerifier() {
      return 'verifier-test'
    },
  }
}

// StreamableHTTPClientTransport keeps the constructor's `requestInit` on a
// private field and merges its headers into every request. Reading it back is
// the only way to assert the wiring without standing up an HTTP server.
function findRequestInitHeaders(transport: Transport): Record<string, string> | undefined {
  return (transport as unknown as { _requestInit?: { headers?: Record<string, string> } })._requestInit?.headers
}

function objectGraphContains(root: unknown, needle: unknown): boolean {
  const seen = new Set<unknown>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === needle) return true
    if (typeof current !== 'object' || current === null || seen.has(current)) continue
    seen.add(current)
    stack.push(...Object.values(current as Record<string, unknown>))
  }
  return false
}

function fakeTransport(): Transport {
  return {
    async start() {},
    async send(_message, _options) {},
    async close() {},
  }
}

function fakeConnectClient(overrides: {
  connect(transport: Transport, options?: RequestOptions): Promise<void>
  close(): Promise<void>
}): McpSdkClient & { connect(transport: Transport, options?: RequestOptions): Promise<void> } {
  return {
    async listTools(_params, _options) {
      return { tools: [] }
    },
    async callTool(_params, _resultSchema, _options) {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    connect: overrides.connect,
    close: overrides.close,
  }
}
