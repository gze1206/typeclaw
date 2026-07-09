import { describe, expect, test } from 'bun:test'

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { McpToolInfo } from './client'
import {
  isSafeAuthProbeTool,
  probeMcpAuth,
  safeAuthProbeAlternatives,
  selectAuthProbeTool,
  type McpAuthProbeTarget,
} from './probe'

const readOnlyTool: McpToolInfo = {
  name: 'list_items',
  description: 'list items',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
}

const unannotatedTool: McpToolInfo = {
  name: 'search',
  description: 'search things',
  inputSchema: { type: 'object', properties: {} },
}

const ok: CallToolResult = { content: [{ type: 'text', text: 'two items' }] }

function target(overrides: Partial<McpAuthProbeTarget> & { tools?: McpToolInfo[] } = {}): McpAuthProbeTarget & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    listTools: overrides.listTools ?? (async () => overrides.tools ?? [readOnlyTool]),
    callTool:
      overrides.callTool ??
      (async (name) => {
        calls.push(name)
        return ok
      }),
  }
}

describe('probeMcpAuth', () => {
  test('a successful protected tool call is what proves authentication', async () => {
    const server = target()
    const result = await probeMcpAuth(server)
    expect(result).toEqual({ status: 'authenticated', tool: 'list_items' })
    // given: tools/list alone must never stand in for proof
    expect(server.calls).toEqual(['list_items'])
  })

  test('a server whose tools/list is public but whose tools 401 is not authenticated', async () => {
    const result = await probeMcpAuth(
      target({
        callTool: async () => {
          throw new UnauthorizedError('HTTP 401')
        },
      }),
    )
    expect(result.status).toBe('unauthenticated')
  })

  test('an unannotated tool is never probed, and the server is not called', async () => {
    const server = target({ tools: [unannotatedTool] })
    const result = await probeMcpAuth(server)
    expect(result.status).toBe('unverifiable')
    expect(server.calls).toEqual([])
  })

  test('a read-only tool with required arguments is not a probe candidate', async () => {
    const tool: McpToolInfo = {
      ...readOnlyTool,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    }
    const result = await probeMcpAuth(target({ tools: [tool] }))
    expect(result.status).toBe('unverifiable')
  })

  test('a destructive tool is not a probe candidate even when marked read-only', async () => {
    const tool: McpToolInfo = { ...readOnlyTool, annotations: { readOnlyHint: true, destructiveHint: true } }
    const result = await probeMcpAuth(target({ tools: [tool] }))
    expect(result.status).toBe('unverifiable')
  })

  test('authProbeTool names a tool the hint heuristic would skip', async () => {
    const server = target({ tools: [unannotatedTool] })
    const result = await probeMcpAuth(server, { probeTool: 'search' })
    expect(result).toEqual({ status: 'authenticated', tool: 'search' })
    expect(server.calls).toEqual(['search'])
  })

  test('an authProbeTool the server does not expose is unverifiable, not authenticated', async () => {
    const result = await probeMcpAuth(target({ tools: [readOnlyTool] }), { probeTool: 'missing' })
    expect(result.status).toBe('unverifiable')
    expect(result.status === 'unverifiable' && result.reason).toContain('missing')
  })

  test('a 401 on tools/list means unauthenticated', async () => {
    const result = await probeMcpAuth(
      target({
        listTools: async () => {
          throw new UnauthorizedError('HTTP 401')
        },
      }),
    )
    expect(result.status).toBe('unauthenticated')
  })

  test('a transport failure on tools/list proves nothing either way', async () => {
    const result = await probeMcpAuth(
      target({
        listTools: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    )
    expect(result.status).toBe('unverifiable')
  })

  test('an in-band auth error result means unauthenticated, not authenticated', async () => {
    const result = await probeMcpAuth(
      target({
        callTool: async () => ({ content: [{ type: 'text', text: 'Unauthorized: token expired' }], isError: true }),
      }),
    )
    expect(result.status).toBe('unauthenticated')
  })

  test('an in-band non-auth error result proves nothing', async () => {
    const result = await probeMcpAuth(
      target({
        callTool: async () => ({ content: [{ type: 'text', text: 'the item store is busy' }], isError: true }),
      }),
    )
    expect(result.status).toBe('unverifiable')
  })

  test('a permission error on the probe tool proves nothing about the credentials', async () => {
    const result = await probeMcpAuth(
      target({
        tools: [readOnlyTool, { ...readOnlyTool, name: 'get_summary' }],
        callTool: async () => ({
          content: [{ type: 'text', text: 'The caller does not have permission' }],
          isError: true,
        }),
      }),
    )
    expect(result.status).toBe('unverifiable')
  })

  test('the first safe candidate is probed when several qualify', async () => {
    const other: McpToolInfo = { ...readOnlyTool, name: 'get_summary' }
    const server = target({ tools: [other, readOnlyTool] })
    await probeMcpAuth(server)
    expect(server.calls).toEqual(['get_summary'])
  })
})

describe('selectAuthProbeTool', () => {
  test('prefers the configured tool over any safe candidate', () => {
    expect(selectAuthProbeTool([readOnlyTool, unannotatedTool], 'search')?.name).toBe('search')
  })

  test('returns undefined when no tool is annotated safe', () => {
    expect(selectAuthProbeTool([unannotatedTool])).toBeUndefined()
  })
})

describe('safeAuthProbeAlternatives', () => {
  test('never offers the tool that just failed as its own replacement', () => {
    const alternative: McpToolInfo = { ...readOnlyTool, name: 'get_summary' }
    const names = safeAuthProbeAlternatives([readOnlyTool, alternative], readOnlyTool.name).map((t) => t.name)
    expect(names).toEqual(['get_summary'])
  })

  test('offers only tools that are themselves safe to probe', () => {
    const alternatives = safeAuthProbeAlternatives([readOnlyTool, unannotatedTool], readOnlyTool.name)
    expect(alternatives).toEqual([])
  })
})

describe('isSafeAuthProbeTool', () => {
  test('a missing readOnlyHint is unknown, not safe', () => {
    expect(isSafeAuthProbeTool(unannotatedTool)).toBe(false)
    expect(isSafeAuthProbeTool({ ...readOnlyTool, annotations: { readOnlyHint: false } })).toBe(false)
  })

  test('an absent inputSchema.required is treated as no required fields', () => {
    expect(isSafeAuthProbeTool({ ...readOnlyTool, inputSchema: {} })).toBe(true)
    expect(isSafeAuthProbeTool({ ...readOnlyTool, inputSchema: null })).toBe(true)
  })
})
