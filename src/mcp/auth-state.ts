import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

import type { McpServer } from '@/config/config'
import type { McpCredential } from '@/secrets/schema'

import { usesStaticAuthorization } from './client'

// The single wording for "this server needs a human to sign in", shared by every
// surface that can hit the condition — the container-mode provider, the tool
// dispatcher, and anything downstream. Keeping one producer stops the runtime
// and the CLI from drifting into telling operators two different things.
export function authRecoveryHint(serverName: string): string {
  return `MCP server "${serverName}" needs authentication. Run on the host: typeclaw mcp auth ${serverName}`
}

// Thrown where an interactive OAuth redirect is impossible (the container has no
// browser). A sentinel class rather than a bare Error so callers classify it by
// type instead of matching on message text.
export class McpOAuthRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(authRecoveryHint(serverName))
    this.name = 'McpOAuthRequiredError'
  }
}

// Whether a failure is one that re-authenticating would fix, as opposed to a
// transport/server error the operator can do nothing about. Only this narrow
// class of failure earns the "go run typeclaw mcp auth" advice — attaching it to
// every error would train operators to ignore it.
//
// Note on the string fallback: these are HTTP status codes and SDK error names —
// protocol tokens the system defines, not natural language a user typed — so the
// repo's multi-language matching rule does not apply here.
export function isAuthFailure(cause: unknown): boolean {
  const seen = new Set<unknown>()
  let current = cause
  // Both the SDK and our own connect path re-wrap errors with `cause`, so the
  // signal is often one or more levels down from the error we catch.
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (current instanceof UnauthorizedError) return true
    if (current instanceof McpOAuthRequiredError) return true
    if (isHttpUnauthorized(current)) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

function isHttpUnauthorized(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  return (cause as { code?: unknown }).code === 401
}

export type McpCredentialState = 'n/a' | 'static header' | 'not configured' | 'configured'

// What `typeclaw mcp list` shows in its OAUTH column.
//
// Keyed on TOKEN presence, not credential presence: dynamic client registration
// writes `client` before the code exchange runs, so a half-finished auth leaves
// `{ client }` with no tokens. Reading that as "configured" is the same mistake
// the old `mcp auth` made — inferring an authenticated state from a signal that
// does not carry it.
//
// Deliberately says nothing about expiry: OAuthTokens carries only `expires_in`,
// relative to an issue time we never record, so any expiry claim here would be
// invented. The SDK refreshes on demand anyway.
export function describeCredentialState(
  server: Pick<McpServer, 'url' | 'headers' | 'bearerToken'>,
  credential: McpCredential | undefined,
): McpCredentialState {
  if (server.url === undefined) return 'n/a'
  if (usesStaticAuthorization(server)) return 'static header'
  if (credential?.tokens === undefined) return 'not configured'
  return 'configured'
}
