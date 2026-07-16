import { describe, expect, test } from 'bun:test'

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { McpServer } from '@/config/config'

import { authRecoveryHint, describeCredentialState, isAuthFailure, McpOAuthRequiredError } from './auth-state'

describe('isAuthFailure', () => {
  test('classifies the SDK UnauthorizedError as recoverable by re-authentication', () => {
    expect(isAuthFailure(new UnauthorizedError())).toBe(true)
  })

  test('classifies a 401 streamable HTTP error as an auth failure', () => {
    expect(isAuthFailure(new StreamableHTTPError(401, 'Unauthorized'))).toBe(true)
  })

  test('classifies our own container-mode OAuth-required error', () => {
    expect(isAuthFailure(new McpOAuthRequiredError('linear'))).toBe(true)
  })

  test('does not classify an unrelated error as an auth failure', () => {
    expect(isAuthFailure(new Error('connection reset'))).toBe(false)
  })

  test('does not classify a non-401 streamable HTTP error as an auth failure', () => {
    expect(isAuthFailure(new StreamableHTTPError(404, 'Not Found'))).toBe(false)
  })

  test('tolerates non-Error causes without throwing', () => {
    expect(isAuthFailure(undefined)).toBe(false)
    expect(isAuthFailure('unauthorized')).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
  })

  test('sees through a wrapper that carries the auth failure as its cause', () => {
    // The SDK and our own connect path both re-wrap errors, so instanceof on the
    // outermost error alone would miss the signal.
    const wrapped = new Error('MCP call failed', { cause: new UnauthorizedError() })

    expect(isAuthFailure(wrapped)).toBe(true)
  })
})

describe('authRecoveryHint', () => {
  test('names the server and the exact command that fixes it', () => {
    const hint = authRecoveryHint('linear')

    expect(hint).toContain('linear')
    expect(hint).toContain('typeclaw mcp auth linear')
  })
})

describe('McpOAuthRequiredError', () => {
  test('carries the recovery hint as its message so container-mode callers stay actionable', () => {
    expect(new McpOAuthRequiredError('linear').message).toBe(authRecoveryHint('linear'))
  })
})

describe('describeCredentialState', () => {
  test('reports stdio servers as not applicable', () => {
    expect(describeCredentialState(stdioServer(), undefined)).toBe('n/a')
  })

  test('reports a bearerToken server as statically authenticated', () => {
    expect(describeCredentialState({ ...httpServer(), bearerToken: { value: 'tok' } }, undefined)).toBe('static header')
  })

  test('reports a server with an explicit Authorization header as statically authenticated', () => {
    expect(
      describeCredentialState({ ...httpServer(), headers: { Authorization: { value: 'Bearer x' } } }, undefined),
    ).toBe('static header')
  })

  test('reports an http server with no credential as not configured', () => {
    expect(describeCredentialState(httpServer(), undefined)).toBe('not configured')
  })

  test('reports a registration-only credential as not configured', () => {
    // Dynamic client registration saves `client` BEFORE the code exchange, so an
    // auth run that died in the middle leaves a credential with no tokens.
    // Keying on credential presence (the old behaviour) called that "configured"
    // and sent the operator looking in the wrong place.
    expect(describeCredentialState(httpServer(), { client: { client_id: 'c1' } })).toBe('not configured')
  })

  test('reports a credential holding tokens as configured', () => {
    expect(describeCredentialState(httpServer(), { tokens: { access_token: 'a', token_type: 'Bearer' } })).toBe(
      'configured',
    )
  })
})

function stdioServer(): McpServer {
  return { name: 'fs', enabled: true, command: 'server', args: [], env: {} }
}

function httpServer(): McpServer {
  return { name: 'linear', enabled: true, url: 'https://mcp.linear.app/mcp', args: [], env: {} }
}
