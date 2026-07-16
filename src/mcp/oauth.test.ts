import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

import { authRecoveryHint, McpOAuthRequiredError } from './auth-state'
import { createFileMcpOAuthStore, TypeClawMcpOAuthProvider } from './oauth'

describe('TypeClawMcpOAuthProvider', () => {
  let dir: string
  let secretsPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-mcp-oauth-'))
    secretsPath = join(dir, 'secrets.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('saves and reloads client, tokens, and discovery through the store', async () => {
    const store = createFileMcpOAuthStore(secretsPath)
    const provider = new TypeClawMcpOAuthProvider('linear', store, {
      mode: 'host',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
      scope: 'read write',
    })
    const client: OAuthClientInformationMixed = { client_id: 'test-client' }
    const tokens: OAuthTokens = {
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'Bearer',
    }
    const rotated: OAuthTokens = {
      access_token: 'access-rotated',
      refresh_token: 'refresh-rotated',
      token_type: 'Bearer',
    }
    const discovery = { authorizationServerUrl: 'https://mcp.example.com' } as OAuthDiscoveryState

    await provider.saveClientInformation(client)
    await provider.saveTokens(tokens)
    await provider.saveDiscoveryState(discovery)
    await provider.saveTokens(rotated)

    const reloaded = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'host',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
    })
    expect(await reloaded.clientInformation()).toEqual(client)
    expect(await reloaded.tokens()).toEqual(rotated)
    expect(await reloaded.discoveryState()).toEqual(discovery)
    const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as { mcp: Record<string, { tokens?: unknown }> }
    expect(raw.mcp.linear?.tokens).toEqual(rotated)
  })

  test('keeps PKCE verifier and state ephemeral instead of writing them to secrets.json', async () => {
    const provider = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'host',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
    })

    await provider.saveClientInformation({ client_id: 'test-client' })
    await provider.saveCodeVerifier('verifier-test')
    const state = await provider.state()

    expect(await provider.codeVerifier()).toBe('verifier-test')
    expect(state).toBeDefined()
    const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as { mcp: Record<string, unknown> }
    expect(JSON.stringify(raw)).not.toContain('verifier-test')
    expect(JSON.stringify(raw)).not.toContain(state)
  })

  test('fixes the CSRF state at construction so the SDK and the auth flow agree on one value', async () => {
    // Regression: a lazily-minted state meant the auth flow's own
    // `await provider.state()` could be the FIRST caller — minting a fresh UUID
    // that the authorization URL never carried — and the comparison against the
    // callback's state then validated nothing.
    const provider = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'host',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
    })

    const first = await provider.state()
    const second = await provider.state()

    expect(first).toBe(second)
    expect(first).not.toBe('')
  })

  test('throws an actionable host command instead of opening a browser in container mode', async () => {
    const provider = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'container',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
    })

    // Shares one wording with every other surface that reports this condition,
    // so the runtime and the CLI cannot drift into two different instructions.
    await expect(provider.redirectToAuthorization(new URL('https://mcp.example.com/oauth'))).rejects.toThrow(
      authRecoveryHint('linear'),
    )
  })

  test('throws a typed error in container mode so callers classify it without matching text', async () => {
    const provider = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'container',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
    })

    await expect(provider.redirectToAuthorization(new URL('https://mcp.example.com/oauth'))).rejects.toBeInstanceOf(
      McpOAuthRequiredError,
    )
  })

  test('exposes public-client metadata for SDK dynamic client registration', () => {
    const provider = new TypeClawMcpOAuthProvider('linear', createFileMcpOAuthStore(secretsPath), {
      mode: 'host',
      redirectUrl: 'http://localhost:1456/callback',
      clientName: 'typeclaw',
      scope: 'read write',
    })

    expect(provider.clientMetadata).toEqual({
      client_name: 'typeclaw',
      redirect_uris: ['http://localhost:1456/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write',
    })
  })
})
