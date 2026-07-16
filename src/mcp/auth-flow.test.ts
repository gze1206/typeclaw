import { describe, expect, test } from 'bun:test'

import type { AuthResult } from '@modelcontextprotocol/sdk/client/auth.js'

import {
  clientRegistrationAcceptsRedirect,
  parseCodeInput,
  runMcpAuthFlow,
  type McpAuthCodeInput,
  type McpAuthFlowDeps,
} from './auth-flow'

const AUTHORIZATION_URL = new URL('https://auth.example.com/authorize?client_id=test')

type FlowHarness = {
  deps: McpAuthFlowDeps
  calls: string[]
  authorizeArgs: ({ authorizationCode?: string } | undefined)[]
  shownUrls: URL[]
}

function createHarness(
  overrides: {
    authorizeResults?: AuthResult[]
    codeInput?: McpAuthCodeInput
    persistedTokens?: unknown
    authorizationUrl?: URL | undefined
    force?: boolean
    expectedState?: string
  } = {},
): FlowHarness {
  const calls: string[] = []
  const authorizeArgs: ({ authorizationCode?: string } | undefined)[] = []
  const shownUrls: URL[] = []
  // Default: no stored tokens, so the SDK would redirect — the shape of a server
  // whose tools/list is public but whose tools/call demands OAuth.
  const authorizeResults = [...(overrides.authorizeResults ?? ['REDIRECT', 'AUTHORIZED'])]
  const expectedState = overrides.expectedState ?? 'state-fixed'

  const deps: McpAuthFlowDeps = {
    serverName: 'linear',
    ...(overrides.force === undefined ? {} : { force: overrides.force }),
    expectedState: async () => expectedState,
    authorize: async (opts) => {
      calls.push('authorize')
      authorizeArgs.push(opts)
      const next = authorizeResults.shift()
      if (next === undefined) throw new Error('authorize called more times than the test scripted')
      return next
    },
    authorizationUrl: () => ('authorizationUrl' in overrides ? overrides.authorizationUrl : AUTHORIZATION_URL),
    onAuthorizationUrl: (url) => {
      calls.push('onAuthorizationUrl')
      shownUrls.push(url)
    },
    waitForCode: async () => {
      calls.push('waitForCode')
      return overrides.codeInput ?? { code: 'auth-code', state: expectedState, source: 'callback' }
    },
    invalidateTokens: async () => {
      calls.push('invalidateTokens')
    },
    readPersistedTokens: async () => {
      calls.push('readPersistedTokens')
      return 'persistedTokens' in overrides ? overrides.persistedTokens : { access_token: 'granted' }
    },
  }

  return { deps, calls, authorizeArgs, shownUrls }
}

describe('runMcpAuthFlow', () => {
  test('runs the real authorization flow when the server exposes tools/list publicly but holds no tokens', async () => {
    // Regression: the old flow probed with client.connect(), which succeeds on a
    // public tools/list, and reported "already authenticated" without ever
    // obtaining a token — leaving the user in a dead loop where the agent says
    // "run typeclaw mcp auth" and that command says "already authenticated".
    const harness = createHarness({ authorizeResults: ['REDIRECT', 'AUTHORIZED'] })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result).toEqual({ ok: true, status: 'authenticated' })
    expect(harness.shownUrls).toEqual([AUTHORIZATION_URL])
    expect(harness.calls).toContain('waitForCode')
  })

  test('exchanges the authorization code on the second authorize call', async () => {
    const harness = createHarness({ authorizeResults: ['REDIRECT', 'AUTHORIZED'] })

    await runMcpAuthFlow(harness.deps)

    expect(harness.authorizeArgs).toEqual([undefined, { authorizationCode: 'auth-code' }])
  })

  test('reports already-authenticated without prompting when authorize resolves AUTHORIZED', async () => {
    const harness = createHarness({ authorizeResults: ['AUTHORIZED'] })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result).toEqual({ ok: true, status: 'already-authenticated' })
    expect(harness.calls).not.toContain('waitForCode')
    expect(harness.calls).not.toContain('onAuthorizationUrl')
  })

  test('invalidates tokens before authorizing when force is set', async () => {
    const harness = createHarness({ force: true, authorizeResults: ['REDIRECT', 'AUTHORIZED'] })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result).toEqual({ ok: true, status: 'authenticated' })
    expect(harness.calls.indexOf('invalidateTokens')).toBeLessThan(harness.calls.indexOf('authorize'))
  })

  test('does not invalidate tokens when force is unset', async () => {
    const harness = createHarness({ authorizeResults: ['AUTHORIZED'] })

    await runMcpAuthFlow(harness.deps)

    expect(harness.calls).not.toContain('invalidateTokens')
  })

  test('rejects a callback that carries no state', async () => {
    // A loopback callback always echoes state. A missing one means the request
    // did not originate from our authorization URL.
    const harness = createHarness({ codeInput: { code: 'auth-code', source: 'callback' } })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('state')
  })

  test('rejects a callback whose state does not match the authorization request', async () => {
    const harness = createHarness({
      codeInput: { code: 'auth-code', state: 'state-attacker', source: 'callback' },
    })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('state')
  })

  test('accepts a manually pasted bare code with no state', async () => {
    // Out-of-band paste: the user is the transport, so there is no callback to forge.
    const harness = createHarness({ codeInput: { code: 'auth-code', source: 'manual' } })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result).toEqual({ ok: true, status: 'authenticated' })
  })

  test('rejects a manually pasted redirect URL whose state does not match', async () => {
    const harness = createHarness({
      codeInput: { code: 'auth-code', state: 'state-attacker', source: 'manual' },
    })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('state')
  })

  test('fails with an actionable reason when the redirect yields no authorization URL', async () => {
    const harness = createHarness({ authorizeResults: ['REDIRECT'], authorizationUrl: undefined })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('authorization URL')
  })

  test('fails when the code exchange does not persist tokens to disk', async () => {
    // Guards the silent-write-failure path (e.g. a hostd secrets-patch rejection
    // in container mode): the exchange resolved, but nothing reached the store.
    const harness = createHarness({ authorizeResults: ['REDIRECT', 'AUTHORIZED'], persistedTokens: undefined })

    const result = await runMcpAuthFlow(harness.deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('persist')
  })

  test('surfaces an authorize failure as a flow failure instead of throwing', async () => {
    const deps: McpAuthFlowDeps = {
      ...createHarness().deps,
      authorize: async () => {
        throw new Error('discovery failed: 404')
      },
    }

    const result = await runMcpAuthFlow(deps)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('discovery failed')
  })
})

describe('clientRegistrationAcceptsRedirect', () => {
  test('accepts a registration whose redirect_uris contain the current callback URL', () => {
    const client = { client_id: 'c1', redirect_uris: ['http://localhost:1456/callback'] }

    expect(clientRegistrationAcceptsRedirect(client, 'http://localhost:1456/callback')).toBe(true)
  })

  test('rejects a registration bound to a different callback port', () => {
    // `typeclaw mcp auth --port 1457` after a registration made on 1456: the
    // authorization server matches redirect_uri exactly and would reject the
    // request, so the stale registration has to be re-minted rather than reused.
    const client = { client_id: 'c1', redirect_uris: ['http://localhost:1456/callback'] }

    expect(clientRegistrationAcceptsRedirect(client, 'http://localhost:1457/callback')).toBe(false)
  })

  test('accepts when there is no registration yet, since dynamic registration will mint one', () => {
    expect(clientRegistrationAcceptsRedirect(undefined, 'http://localhost:1456/callback')).toBe(true)
  })

  test('accepts a registration that declares no redirect_uris rather than churning a usable client_id', () => {
    const client = { client_id: 'c1' }

    expect(clientRegistrationAcceptsRedirect(client, 'http://localhost:1456/callback')).toBe(true)
  })
})

describe('parseCodeInput', () => {
  test('extracts code and state from a full redirect URL', () => {
    expect(parseCodeInput('http://localhost:1456/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      source: 'manual',
    })
  })

  test('treats a bare code as a manual paste with no state', () => {
    expect(parseCodeInput('abc')).toEqual({ code: 'abc', source: 'manual' })
  })

  test('marks a URL parsed from the callback server as callback-sourced', () => {
    expect(parseCodeInput(new URL('http://localhost:1456/callback?code=abc&state=xyz'), 'callback')).toEqual({
      code: 'abc',
      state: 'xyz',
      source: 'callback',
    })
  })

  test('returns null for blank input', () => {
    expect(parseCodeInput('   ')).toBeNull()
  })

  test('returns null for a redirect URL without a code', () => {
    expect(parseCodeInput('http://localhost:1456/callback?state=xyz')).toBeNull()
  })
})
