import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { McpToolInfo } from './client'

// A live tool call is the only thing that proves a login worked. `tools/list` is
// public metadata on a large share of servers — it answers happily with no token
// at all — so treating a successful listing as "authenticated" strands the user:
// no credentials are stored anywhere, yet every code path believes the server is
// already logged in, and the login flow refuses to run again.
export type McpAuthProbeTarget = {
  listTools(): Promise<McpToolInfo[]>
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>
}

export type McpAuthProbeResult =
  // A protected tool call went through: credentials are real and accepted.
  | { status: 'authenticated'; tool: string }
  // The server rejected us on an auth boundary. A login should fix it.
  | { status: 'unauthenticated'; reason: string }
  // Nothing was proven either way. Never collapse this into 'authenticated'.
  | { status: 'unverifiable'; reason: string }

export const NO_PROBE_TOOL_REASON =
  'no tool is safe to call as an auth probe (needs readOnlyHint, no destructiveHint, and no required arguments). ' +
  'Name a safe read-only tool with "authProbeTool" in typeclaw.json to verify this server.'

/**
 * Run one real tool call against `target` and report what it proves.
 *
 * `probeTool` names an operator-chosen tool and bypasses hint inspection: the
 * operator has vouched for it. Without it, only a tool the server itself marks
 * as read-only, non-destructive, and argument-free is eligible — an unannotated
 * tool could be `delete_everything`, and probing must never mutate state.
 */
export async function probeMcpAuth(
  target: McpAuthProbeTarget,
  opts: { probeTool?: string } = {},
): Promise<McpAuthProbeResult> {
  let tools: McpToolInfo[]
  try {
    tools = await target.listTools()
  } catch (cause) {
    return isAuthFailure(cause)
      ? { status: 'unauthenticated', reason: `the server rejected tools/list: ${describe(cause)}` }
      : { status: 'unverifiable', reason: `tools/list failed: ${describe(cause)}` }
  }

  const tool = selectAuthProbeTool(tools, opts.probeTool)
  if (tool === undefined) {
    return {
      status: 'unverifiable',
      reason:
        opts.probeTool === undefined
          ? NO_PROBE_TOOL_REASON
          : `authProbeTool "${opts.probeTool}" is not exposed by this server`,
    }
  }

  let result: CallToolResult
  try {
    result = await target.callTool(tool.name, {})
  } catch (cause) {
    return isAuthFailure(cause)
      ? { status: 'unauthenticated', reason: `the server rejected "${tool.name}": ${describe(cause)}` }
      : { status: 'unverifiable', reason: probeFailedReason(tool, tools, `failed: ${describe(cause)}`) }
  }

  if (result.isError !== true) return { status: 'authenticated', tool: tool.name }

  // An in-band error means the request reached the tool, but some servers report
  // an expired token this way instead of with a 401, so read the text before
  // deciding which side of the auth boundary we ended up on.
  const text = resultText(result)
  return isAuthFailure(text)
    ? { status: 'unauthenticated', reason: `"${tool.name}" reported an auth error: ${text}` }
    : { status: 'unverifiable', reason: probeFailedReason(tool, tools, `returned an error result: ${text}`) }
}

/**
 * Safe probe candidates other than `rejected`, best-first.
 *
 * A probe that fails for a non-auth reason is a bad probe, not a failed login:
 * the chosen tool may need permissions the credentials legitimately lack, which
 * is why the tool that just failed is never offered as its own replacement.
 */
export function safeAuthProbeAlternatives(tools: McpToolInfo[], rejected: string): McpToolInfo[] {
  return tools.filter((candidate) => candidate.name !== rejected && isSafeAuthProbeTool(candidate))
}

const MAX_SUGGESTED_ALTERNATIVES = 3

function probeFailedReason(tool: McpToolInfo, tools: McpToolInfo[], detail: string): string {
  const alternatives = safeAuthProbeAlternatives(tools, tool.name)
  const hint =
    alternatives.length === 0
      ? 'Set "authProbeTool" in typeclaw.json to probe a tool these credentials can call.'
      : `Set "authProbeTool" in typeclaw.json to probe a different tool, e.g. ${alternatives
          .slice(0, MAX_SUGGESTED_ALTERNATIVES)
          .map((candidate) => `"${candidate.name}"`)
          .join(', ')}.`
  return `probe tool "${tool.name}" ${detail}. ${hint}`
}

export function selectAuthProbeTool(tools: McpToolInfo[], probeTool?: string): McpToolInfo | undefined {
  if (probeTool !== undefined) return tools.find((tool) => tool.name === probeTool)
  return tools.find(isSafeAuthProbeTool)
}

export function isSafeAuthProbeTool(tool: McpToolInfo): boolean {
  if (tool.annotations?.readOnlyHint !== true) return false
  if (tool.annotations.destructiveHint === true) return false
  return requiredInputFields(tool.inputSchema).length === 0
}

// Probing calls tools with `{}`, so anything with a required argument is out:
// the server would reject it for a schema violation and tell us nothing about
// whether our credentials were accepted.
function requiredInputFields(inputSchema: unknown): string[] {
  if (typeof inputSchema !== 'object' || inputSchema === null) return []
  const required = (inputSchema as { required?: unknown }).required
  if (!Array.isArray(required)) return []
  return required.filter((field): field is string => typeof field === 'string')
}

const AUTH_FAILURE_PATTERN = /\b(401|403|unauthorized|forbidden|invalid_token|invalid_grant|not authenticated)\b/i

// The SDK raises UnauthorizedError for a 401 on an HTTP transport, but servers
// also surface auth failures as plain JSON-RPC errors, so fall back to the text.
function isAuthFailure(cause: unknown): boolean {
  if (cause instanceof UnauthorizedError) return true
  return AUTH_FAILURE_PATTERN.test(typeof cause === 'string' ? cause : describe(cause))
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function resultText(result: CallToolResult): string {
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
  return text === '' ? '(no error message)' : text
}
