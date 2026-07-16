import { describe, expect, test } from 'bun:test'

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

import type { McpServer } from '@/config/config'

import type { McpConnection, McpToolInfo } from './client'
import { createMcpManager, namespaceToolName, parseNamespacedTool } from './manager'

describe('MCP tool namespacing', () => {
  test('round-trips tool names that contain the separator by splitting on the first separator', () => {
    const namespaced = namespaceToolName('filesystem', 'read__file')

    expect(namespaced).toBe('filesystem__read__file')
    expect(parseNamespacedTool(namespaced)).toEqual({ server: 'filesystem', tool: 'read__file' })
  })

  test('rejects names without both sides of the separator', () => {
    expect(parseNamespacedTool('plain')).toBeUndefined()
    expect(parseNamespacedTool('__tool')).toBeUndefined()
    expect(parseNamespacedTool('server__')).toBeUndefined()
  })
})

describe('createMcpManager', () => {
  test('keeps healthy servers connected when one server fails and closes every open connection', async () => {
    const closed: string[] = []
    const servers: McpServer[] = [server('alpha'), server('broken'), server('gamma')]
    const manager = createMcpManager(servers, {
      env: {},
      async connect(mcpServer) {
        if (mcpServer.name === 'broken') throw new Error('cannot connect')
        return fakeConnection(
          mcpServer.name,
          [{ name: `${mcpServer.name}-tool`, description: '', inputSchema: {} }],
          closed,
        )
      },
    })

    const results = await manager.connectAll()

    expect(results.map((result) => ({ name: result.name, ok: result.ok }))).toEqual([
      { name: 'alpha', ok: true },
      { name: 'broken', ok: false },
      { name: 'gamma', ok: true },
    ])
    expect(manager.getConnection('alpha')?.name).toBe('alpha')
    expect(manager.getConnection('broken')).toBeUndefined()
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: true, toolCount: 1 },
      { name: 'broken', connected: false },
      { name: 'gamma', connected: true, toolCount: 1 },
    ])

    await manager.closeAll()

    expect(closed.sort()).toEqual(['alpha', 'gamma'])
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: false },
      { name: 'broken', connected: false },
      { name: 'gamma', connected: false },
    ])
  })

  test('keeps disabled servers invisible to connection lookup and server listing', async () => {
    const connected: string[] = []
    const servers: McpServer[] = [server('alpha'), server('disabled', false), server('gamma')]
    const manager = createMcpManager(servers, {
      env: {},
      async connect(mcpServer) {
        connected.push(mcpServer.name)
        return fakeConnection(
          mcpServer.name,
          [{ name: `${mcpServer.name}-tool`, description: '', inputSchema: {} }],
          [],
        )
      },
    })

    const results = await manager.connectAll()

    expect(connected).toEqual(['alpha', 'gamma'])
    expect(results.map((result) => result.name)).toEqual(['alpha', 'gamma'])
    expect(manager.getConnection('disabled')).toBeUndefined()
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: true, toolCount: 1 },
      { name: 'gamma', connected: true, toolCount: 1 },
    ])
  })

  test('threads an abort signal to each connector', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const abort = new AbortController()
    const manager = createMcpManager([server('alpha'), server('gamma')], {
      env: {},
      async connect(mcpServer, opts) {
        signals.push(opts.signal)
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    await manager.connectAll({ signal: abort.signal })

    expect(signals).toEqual([abort.signal, abort.signal])
  })

  test('threads auth providers from the factory to HTTP connector calls', async () => {
    const authProvider = fakeAuthProvider()
    const authProviders: Array<OAuthClientProvider | undefined> = []
    const manager = createMcpManager([httpServer('remote'), server('local')], {
      env: {},
      authProvider: (mcpServer) => (mcpServer.url === undefined ? undefined : authProvider),
      async connect(mcpServer, opts) {
        authProviders.push(opts.authProvider)
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    await manager.connectAll()

    expect(authProviders).toEqual([authProvider, undefined])
  })

  test('fails a duplicate server name fast instead of shadowing the first connection', async () => {
    const connectCalls: string[] = []
    const manager = createMcpManager([server('dup'), server('dup'), server('other')], {
      env: {},
      async connect(mcpServer) {
        connectCalls.push(mcpServer.name)
        return fakeConnection(
          mcpServer.name,
          [{ name: `${mcpServer.name}-tool`, description: '', inputSchema: {} }],
          [],
        )
      },
    })

    const results = await manager.connectAll()

    expect(results.map((result) => ({ name: result.name, ok: result.ok }))).toEqual([
      { name: 'dup', ok: true },
      { name: 'dup', ok: false },
      { name: 'other', ok: true },
    ])
    const duplicate = results[1]
    if (duplicate === undefined || duplicate.ok) throw new Error('expected the second server to fail as a duplicate')
    expect(duplicate.error.message).toMatch(/mcpServers\[1\]\.name duplicates mcpServers\[0\]\.name/)
    expect(connectCalls).toEqual(['dup', 'other'])
    expect(manager.getConnection('dup')?.name).toBe('dup')
  })

  test('refresh updates cached tool counts from live connections', async () => {
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        return changingConnection(mcpServer.name)
      },
    })

    await manager.connectAll()
    expect(manager.listServers()).toEqual([{ name: 'alpha', connected: true, toolCount: 1 }])

    const results = await manager.refresh()

    expect(results).toEqual([{ ok: true, name: 'alpha', toolCount: 2 }])
    expect(manager.listServers()).toEqual([{ name: 'alpha', connected: true, toolCount: 2 }])
  })

  test('surfaces a marked auth failure through listServers', async () => {
    const manager = createMcpManager([httpServer('linear'), httpServer('acme')], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [{ name: 'tool', description: '', inputSchema: {} }], [])
      },
    })
    await manager.connectAll()

    manager.markAuthFailure('linear')

    expect(manager.listServers()).toEqual([
      { name: 'linear', connected: true, toolCount: 1, authState: 'needs-auth' },
      { name: 'acme', connected: true, toolCount: 1 },
    ])
  })

  test('ignores an auth failure marked against an unconfigured server', async () => {
    const manager = createMcpManager([httpServer('linear')], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [{ name: 'tool', description: '', inputSchema: {} }], [])
      },
    })
    await manager.connectAll()

    manager.markAuthFailure('ghost')

    expect(manager.listServers()).toEqual([{ name: 'linear', connected: true, toolCount: 1 }])
  })

  test('clears auth failures on closeAll so a restarted manager does not inherit them', async () => {
    const manager = createMcpManager([httpServer('linear')], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [{ name: 'tool', description: '', inputSchema: {} }], [])
      },
    })
    await manager.connectAll()
    manager.markAuthFailure('linear')

    await manager.closeAll()

    expect(manager.listServers()).toEqual([{ name: 'linear', connected: false }])
  })

  test('refresh isolates a failing connection so healthy servers still update', async () => {
    const manager = createMcpManager([server('healthy'), server('broken')], {
      env: {},
      async connect(mcpServer) {
        if (mcpServer.name === 'broken') return failingRefreshConnection(mcpServer.name)
        return changingConnection(mcpServer.name)
      },
    })

    await manager.connectAll()
    expect(manager.listServers()).toEqual([
      { name: 'healthy', connected: true, toolCount: 1 },
      { name: 'broken', connected: true, toolCount: 1 },
    ])

    const results = await manager.refresh()

    const healthy = results.find((result) => result.name === 'healthy')
    const broken = results.find((result) => result.name === 'broken')
    expect(healthy).toEqual({ ok: true, name: 'healthy', toolCount: 2 })
    if (broken === undefined || broken.ok) throw new Error('expected the broken server to fail refresh')
    expect(broken.error.message).toMatch(/refresh boom/)
    expect(manager.listServers()).toEqual([
      { name: 'healthy', connected: true, toolCount: 2 },
      { name: 'broken', connected: true, toolCount: 1 },
    ])
  })
})

describe('ensureConnected and readiness', () => {
  test('connects a configured server on demand and reuses the connection', async () => {
    const connectCalls: string[] = []
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        connectCalls.push(mcpServer.name)
        return fakeConnection(mcpServer.name, [{ name: 'a', description: '', inputSchema: {} }], [])
      },
    })

    expect(manager.getConnection('alpha')).toBeUndefined()
    const first = await manager.ensureConnected('alpha')
    const second = await manager.ensureConnected('alpha')

    expect(first?.name).toBe('alpha')
    expect(second).toBe(first)
    expect(manager.getConnection('alpha')?.name).toBe('alpha')
    expect(connectCalls).toEqual(['alpha'])
  })

  test('returns undefined for an unknown server without connecting', async () => {
    const connectCalls: string[] = []
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        connectCalls.push(mcpServer.name)
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    expect(await manager.ensureConnected('missing')).toBeUndefined()
    expect(connectCalls).toEqual([])
  })

  test('returns undefined for a disabled server', async () => {
    const manager = createMcpManager([server('off', false)], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    expect(await manager.ensureConnected('off')).toBeUndefined()
  })

  test('coalesces a warm-up and a racing lazy connect onto a single attempt', async () => {
    let connectCalls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        connectCalls += 1
        await gate
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    const warmup = manager.connectAll()
    const lazy = manager.ensureConnected('alpha')
    release?.()
    const [warmupResults, lazyConn] = await Promise.all([warmup, lazy])

    expect(connectCalls).toBe(1)
    expect(lazyConn?.name).toBe('alpha')
    expect(warmupResults.map((result) => ({ name: result.name, ok: result.ok }))).toEqual([{ name: 'alpha', ok: true }])
  })

  test('retries a server whose first lazy connect failed', async () => {
    let attempt = 0
    const manager = createMcpManager([server('flaky')], {
      env: {},
      async connect(mcpServer) {
        attempt += 1
        if (attempt === 1) throw new Error('first attempt fails')
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    expect(await manager.ensureConnected('flaky')).toBeUndefined()
    expect((await manager.ensureConnected('flaky'))?.name).toBe('flaky')
    expect(attempt).toBe(2)
  })

  test('whenInitialConnectSettled resolves once the warm-up completes', async () => {
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    await manager.connectAll()
    await manager.whenInitialConnectSettled()

    expect(manager.getConnection('alpha')?.name).toBe('alpha')
  })

  test('whenInitialConnectSettled returns immediately when no warm-up was started', async () => {
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    const start = Date.now()
    await manager.whenInitialConnectSettled({ timeoutMs: 10_000 })

    expect(Date.now() - start).toBeLessThan(1_000)
  })

  test('whenInitialConnectSettled stops waiting at the timeout when a server hangs', async () => {
    const manager = createMcpManager([server('slow')], {
      env: {},
      connect() {
        return new Promise<McpConnection>(() => {})
      },
    })

    void manager.connectAll()
    const start = Date.now()
    await manager.whenInitialConnectSettled({ timeoutMs: 20 })

    expect(Date.now() - start).toBeLessThan(1_000)
    expect(manager.getConnection('slow')).toBeUndefined()
  })

  test('whenInitialConnectSettled with no timeout waits for a multi-page listTools catalog to finish', async () => {
    // given: a server whose listTools settles only after several cursor pages,
    // whose total exceeds any fixed connect+one-request cap
    const manager = createMcpManager([server('paginated')], {
      env: {},
      async connect(mcpServer) {
        return paginatedListConnection(mcpServer.name, 3, 25)
      },
    })

    void manager.connectAll()
    await manager.whenInitialConnectSettled()

    // then: the gate waited for every page, so the full tool count is catalogued
    expect(manager.listServers()).toEqual([{ name: 'paginated', connected: true, toolCount: 3 }])
  })

  test('whenInitialConnectSettled waits through listTools, not just connect, before the catalog is read', async () => {
    // given: a server that connects instantly but whose listTools() is slow
    const manager = createMcpManager([server('slow-list')], {
      env: {},
      async connect(mcpServer) {
        return slowListConnection(mcpServer.name, 40, [
          { name: 'a', description: '', inputSchema: {} },
          { name: 'b', description: '', inputSchema: {} },
        ])
      },
    })

    void manager.connectAll()
    await manager.whenInitialConnectSettled()

    // then: the gate waited for the tool catalog, so the server is connected with its count
    expect(manager.listServers()).toEqual([{ name: 'slow-list', connected: true, toolCount: 2 }])
  })

  test('closes a connection that resolves after closeAll() instead of caching it', async () => {
    // given: a gated connect that resolves only after we release it
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const closed: string[] = []
    const manager = createMcpManager([server('late')], {
      env: {},
      async connect(mcpServer) {
        await gate
        return fakeConnection(mcpServer.name, [], closed)
      },
    })

    // when: a connect is in flight, the manager is shut down, then the connect resolves
    const connecting = manager.connectAll()
    await manager.closeAll()
    release?.()
    await connecting

    // then: the late connection was closed, never cached, and ensureConnected refuses
    expect(closed).toEqual(['late'])
    expect(manager.getConnection('late')).toBeUndefined()
    expect(await manager.ensureConnected('late')).toBeUndefined()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function slowListConnection(name: string, listDelayMs: number, tools: McpToolInfo[]): McpConnection {
  return {
    name,
    async listTools() {
      await delay(listDelayMs)
      return tools
    },
    async refresh() {
      return tools
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}

function paginatedListConnection(name: string, pages: number, pageDelayMs: number): McpConnection {
  const listTools = async (): Promise<McpToolInfo[]> => {
    const tools: McpToolInfo[] = []
    for (let page = 0; page < pages; page++) {
      await delay(pageDelayMs)
      tools.push({ name: `tool-${page}`, description: '', inputSchema: {} })
    }
    return tools
  }
  return {
    name,
    listTools,
    refresh: listTools,
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}

function server(name: string, enabled = true): McpServer {
  return { name, enabled, command: 'server-command', args: [], env: {} }
}

function httpServer(name: string): McpServer {
  return { name, enabled: true, url: 'https://mcp.example.com/mcp', args: [], env: {} }
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

function fakeConnection(name: string, tools: McpToolInfo[], closed: string[]): McpConnection {
  return {
    name,
    async listTools() {
      return tools
    },
    async refresh() {
      return tools
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {
      closed.push(name)
    },
  }
}

function changingConnection(name: string): McpConnection {
  let calls = 0
  const listTools = async (): Promise<McpToolInfo[]> => {
    calls += 1
    return Array.from({ length: calls }, (_value, index) => ({
      name: `tool-${index}`,
      description: '',
      inputSchema: {},
    }))
  }
  return {
    name,
    listTools,
    refresh: listTools,
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}

function failingRefreshConnection(name: string): McpConnection {
  return {
    name,
    async listTools() {
      return [{ name: `${name}-tool`, description: '', inputSchema: {} }]
    },
    async refresh() {
      throw new Error('refresh boom')
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}
