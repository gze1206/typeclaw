import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { enforceAndPinToolFiles } from '@/agent/tool-file-safety'
import { defineTool } from '@/plugin/define'
import type { ContentPart, Tool, ToolResult } from '@/plugin/types'

import { authRecoveryHint, isAuthFailure } from './auth-state'
import type { McpConnection, McpToolInfo } from './client'
import type { McpManager } from './manager'
import { namespaceToolName, parseNamespacedTool } from './manager'
import { isToolAllowed } from './tool-policy'

export const MCP_DISPATCHER_TOOL_NAMES = ['mcp_list_tools', 'mcp_describe', 'mcp_call'] as const

export type McpListToolsArgs = { server: string }
export type McpDescribeArgs = { server: string; tool: string }
export type McpCallArgs = { server: string; tool: string; args?: Record<string, unknown> }
export type McpDispatcherTool = Tool<McpListToolsArgs> | Tool<McpDescribeArgs> | Tool<McpCallArgs>
export type McpDispatcherTools = [Tool<McpListToolsArgs>, Tool<McpDescribeArgs>, Tool<McpCallArgs>]

export function createMcpDispatcherTools(manager: McpManager): McpDispatcherTools {
  return [createListToolsTool(manager), createDescribeTool(manager), createCallTool(manager)]
}

function createListToolsTool(manager: McpManager): Tool<McpListToolsArgs> {
  return defineTool<McpListToolsArgs>({
    description: 'List the tools exposed by one connected MCP server. Returns namespaced tool ids and descriptions.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
    }),
    async execute(args) {
      const connection = await manager.ensureConnected(args.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, args.server))

      const tools = await visibleTools(manager, args.server, connection)
      if (tools.length === 0) return textResult(`MCP server ${JSON.stringify(args.server)} exposes no tools.`)

      const lines = tools.map((tool) => {
        const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
        return `- ${namespaceToolName(args.server, tool.name)} — ${description}`
      })
      return textResult(`Tools for MCP server ${JSON.stringify(args.server)}:\n${lines.join('\n')}`)
    },
  })
}

function createDescribeTool(manager: McpManager): Tool<McpDescribeArgs> {
  return defineTool<McpDescribeArgs>({
    description: 'Describe one MCP tool. Returns its description and full input JSON Schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
    }),
    async execute(args) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = await manager.ensureConnected(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      const tools = await visibleTools(manager, resolved.server, connection)
      const tool = tools.find((item) => item.name === resolved.tool)
      if (tool === undefined) {
        return textResult(unknownToolMessageFor(resolved.server, resolved.tool, tools))
      }

      const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
      return textResult(
        [
          `MCP tool ${namespaceToolName(resolved.server, tool.name)}`,
          `Description: ${description}`,
          '',
          'Input schema:',
          '```json',
          JSON.stringify(tool.inputSchema, null, 2),
          '```',
        ].join('\n'),
      )
    },
  })
}

function createCallTool(manager: McpManager): Tool<McpCallArgs> {
  return defineTool<McpCallArgs>({
    description: 'Call an MCP tool on a connected server. Use mcp_describe first to learn the input schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments matching the tool input schema.'),
    }),
    async execute(args, ctx) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = await manager.ensureConnected(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      // Gate BEFORE the request goes out: a denied call that reaches the server
      // has already had its side effect by the time we refuse it. The refusal
      // mirrors the unknown-tool wording so list/describe/call describe one
      // world — a tool the policy hides simply does not exist.
      if (!allowsTool(manager, resolved.server, resolved.tool)) {
        return textResult(await unknownToolMessage(manager, resolved.server, resolved.tool, connection))
      }

      const toolArgs = args.args ?? {}
      const pinned = await enforceAndPinToolFiles({
        tool: 'mcp_call',
        args: toolArgs,
        agentDir: ctx.agentDir,
        genericInputs: true,
        signal: ctx.signal,
      })
      try {
        const result = await safeCallTool(manager, resolved.server, connection, resolved.tool, toolArgs)
        return pinned.restoreResult(mapCallToolResult(resolved.server, resolved.tool, result))
      } finally {
        await pinned.cleanup()
      }
    },
  })
}

function resolveToolArgs(server: string, tool: string): { server: string; tool: string } {
  const parsed = parseNamespacedTool(tool)
  return parsed ?? { server, tool }
}

function unknownServerMessage(manager: McpManager, server: string): string {
  // List every configured server, not just connected ones: under lazy connect a
  // valid server is reached only when ensureConnected returns undefined for a
  // name that isn't configured at all, so filtering by `connected` here would
  // report "none" while servers exist.
  const available = manager
    .listServers()
    .map((entry) => entry.name)
    .join(', ')
  return `Unknown MCP server ${JSON.stringify(server)}. Available servers: ${available || 'none'}.`
}

// The tool list as the model is allowed to see it. Every dispatcher reads the
// catalog through here, so a policy-hidden tool is invisible to list, describe
// and call alike rather than only to whichever one remembered to filter.
async function visibleTools(manager: McpManager, server: string, connection: McpConnection): Promise<McpToolInfo[]> {
  const tools = await safeListTools(manager, server, connection)
  const declared = manager.getServer(server)
  if (declared === undefined) return tools
  return tools.filter((tool) => isToolAllowed(declared, tool.name))
}

function allowsTool(manager: McpManager, server: string, tool: string): boolean {
  const declared = manager.getServer(server)
  if (declared === undefined) return true
  return isToolAllowed(declared, tool)
}

function unknownToolMessageFor(server: string, tool: string, tools: McpToolInfo[]): string {
  const available = tools.map((item) => namespaceToolName(server, item.name)).join(', ')
  return `Unknown MCP tool ${JSON.stringify(tool)} on server ${JSON.stringify(server)}. Available tools: ${available || 'none'}.`
}

async function unknownToolMessage(
  manager: McpManager,
  server: string,
  tool: string,
  connection: McpConnection,
): Promise<string> {
  return unknownToolMessageFor(server, tool, await visibleTools(manager, server, connection))
}

async function safeListTools(manager: McpManager, server: string, connection: McpConnection): Promise<McpToolInfo[]> {
  try {
    return await connection.listTools()
  } catch (cause) {
    throw toDispatcherError(manager, server, cause, 'MCP list tools failed')
  }
}

async function safeCallTool(
  manager: McpManager,
  server: string,
  connection: McpConnection,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return await connection.callTool(tool, args)
  } catch (cause) {
    throw toDispatcherError(manager, server, cause, 'MCP call failed')
  }
}

// An auth failure is the one MCP error a human can actually clear, so it gets
// the command instead of a sanitized 401 the model can only relay. Everything
// else keeps the generic prefix — if the hint appeared on every failure it would
// stop carrying information.
function toDispatcherError(manager: McpManager, server: string, cause: unknown, prefix: string): Error {
  if (isAuthFailure(cause)) {
    manager.markAuthFailure(server)
    return new Error(authRecoveryHint(server))
  }
  return new Error(`${prefix}: ${sanitizeMcpError(errorMessage(cause))}`)
}

function mapCallToolResult(server: string, tool: string, result: CallToolResult): ToolResult {
  const content = result.content.map(mapMcpContentPart)
  if (result.isError === true) {
    return {
      content: content.map((part) =>
        part.type === 'text' ? { type: 'text' as const, text: `MCP tool error: ${sanitizeMcpError(part.text)}` } : part,
      ),
      details: { server, tool, isError: true },
    }
  }
  return { content, details: { server, tool, isError: false } }
}

function mapMcpContentPart(part: CallToolResult['content'][number]): ContentPart {
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
  if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
    return { type: 'image', mimeType: part.mimeType, data: part.data }
  }
  return { type: 'text', text: summarizeUnsupportedPart(part) }
}

function summarizeUnsupportedPart(part: CallToolResult['content'][number]): string {
  const type = typeof part.type === 'string' ? part.type : 'unknown'
  const uri = readNestedString(part, 'resource', 'uri') ?? readString(part, 'uri')
  if (uri !== undefined) return `[mcp:${type} ${uri}]`
  const mimeType = readNestedString(part, 'resource', 'mimeType') ?? readString(part, 'mimeType')
  if (mimeType !== undefined) return `[mcp:${type} ${mimeType}]`
  return `[mcp:${type} omitted]`
}

export function sanitizeMcpError(raw: string): string {
  const scrubbed = raw
    .replace(/\b([A-Z_][A-Z0-9_]*)=\S+/g, '$1=<redacted>')
    .replace(/(?:\/[\w.-]+)+/g, '<path>')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '<path>')
  return scrubbed.length <= 500 ? scrubbed : `${scrubbed.slice(0, 497)}...`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

function readNestedString(value: unknown, key: string, nestedKey: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return readString((value as Record<string, unknown>)[key], nestedKey)
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
