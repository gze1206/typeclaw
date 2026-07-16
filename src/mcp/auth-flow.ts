import type { AuthResult } from '@modelcontextprotocol/sdk/client/auth.js'

// Where an authorization code reached us. The distinction is load-bearing for
// CSRF: a loopback callback always echoes the `state` we put in the
// authorization URL, so a callback without one did not come from our request. A
// manual paste has no forgeable transport — the user is the channel — so a bare
// code is legitimate there.
export type McpAuthCodeSource = 'callback' | 'manual'

export type McpAuthCodeInput = { code: string; state?: string; source: McpAuthCodeSource }

export type McpAuthFlowDeps = {
  serverName: string
  // Wipe stored tokens before authorizing, so `--force` re-runs the real flow
  // instead of short-circuiting on a refresh. The dynamic client registration is
  // deliberately NOT invalidated: its `redirect_uris` are bound to our callback
  // port, and re-registering on every re-auth would churn client_ids.
  force?: boolean
  expectedState: () => Promise<string>
  authorize: (opts?: { authorizationCode?: string }) => Promise<AuthResult>
  authorizationUrl: () => URL | undefined
  onAuthorizationUrl: (url: URL) => void
  waitForCode: () => Promise<McpAuthCodeInput>
  invalidateTokens: () => Promise<void>
  readPersistedTokens: () => Promise<unknown>
}

export type McpAuthFlowOutcome =
  | { ok: true; status: 'already-authenticated' | 'authenticated' }
  | { ok: false; reason: string }

// WHY the SDK's `auth()` is the authority, and `client.connect()` is not:
// `authInternal` resolves to 'AUTHORIZED' only when it actually holds tokens
// (a successful refresh, or a code exchange); otherwise it calls
// redirectToAuthorization() and resolves 'REDIRECT'. A `connect()` handshake
// proves nothing by comparison — a server whose tools/list is public accepts it
// with no credentials at all, which is exactly how the previous implementation
// concluded "already authenticated" while holding zero tokens and left the
// operator in a loop: the agent says `typeclaw mcp auth X`, and `mcp auth X`
// says it is already done.
export async function runMcpAuthFlow(deps: McpAuthFlowDeps): Promise<McpAuthFlowOutcome> {
  try {
    if (deps.force === true) await deps.invalidateTokens()

    const initial = await deps.authorize()
    if (initial === 'AUTHORIZED') return { ok: true, status: 'already-authenticated' }

    const authorizationUrl = deps.authorizationUrl()
    if (authorizationUrl === undefined) {
      return { ok: false, reason: 'OAuth server did not provide an authorization URL.' }
    }
    deps.onAuthorizationUrl(authorizationUrl)

    const input = await deps.waitForCode()
    const stateError = validateAuthState(input, await deps.expectedState())
    if (stateError !== undefined) return { ok: false, reason: stateError }

    await deps.authorize({ authorizationCode: input.code })

    // Re-read through a fresh store so a silent write failure (a rejected hostd
    // secrets-patch in container mode, a lock contention loss) cannot be
    // reported as success. This replaces the old network verify, which called
    // connect()+listTools() — both public on the very servers this flow exists
    // for, so it proved nothing while creating a "saved but unverified" state
    // with no safe rollback.
    const tokens = await deps.readPersistedTokens()
    if (tokens === undefined) {
      return { ok: false, reason: `MCP server "${deps.serverName}" did not persist tokens after the code exchange.` }
    }

    return { ok: true, status: 'authenticated' }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

function validateAuthState(input: McpAuthCodeInput, expected: string): string | undefined {
  if (input.state === undefined) {
    if (input.source === 'callback') {
      return 'OAuth callback did not include a state parameter; refusing to exchange the code.'
    }
    return undefined
  }
  if (input.state !== expected) return 'OAuth callback state did not match the authorization request.'
  return undefined
}

// A stored dynamic client registration pins the callback URL it was minted
// with. When the flow runs on a different port (`--port`, after a collision on
// the default), the authorization server matches redirect_uri exactly and
// rejects the request — so a stale registration must be dropped and re-minted.
// Unknown/absent shapes return true: dynamic registration will mint what's
// missing, and churning a working client_id on a metadata quirk is worse than
// letting the AS speak for itself.
export function clientRegistrationAcceptsRedirect(client: unknown, redirectUrl: string): boolean {
  if (typeof client !== 'object' || client === null) return true
  const redirectUris = (client as { redirect_uris?: unknown }).redirect_uris
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return true
  return redirectUris.includes(redirectUrl)
}

export function parseCodeInput(input: string | URL, source: McpAuthCodeSource = 'manual'): McpAuthCodeInput | null {
  if (input instanceof URL) {
    const code = input.searchParams.get('code')
    if (code === null || code.trim() === '') return null
    const state = input.searchParams.get('state') ?? undefined
    return { code, ...(state === undefined ? {} : { state }), source }
  }
  const trimmed = input.trim()
  if (trimmed === '') return null
  try {
    return parseCodeInput(new URL(trimmed), source)
  } catch {
    return { code: trimmed, source }
  }
}
