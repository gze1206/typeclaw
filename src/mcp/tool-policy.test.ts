import { describe, expect, test } from 'bun:test'

import { isToolAllowed } from './tool-policy'

describe('isToolAllowed', () => {
  test('allows every tool when neither list is configured', () => {
    expect(isToolAllowed({}, 'create_issue')).toBe(true)
  })

  test('admits only listed tools when allowTools is set', () => {
    const server = { allowTools: ['search'] }

    expect(isToolAllowed(server, 'search')).toBe(true)
    expect(isToolAllowed(server, 'create_issue')).toBe(false)
  })

  test('blocks listed tools when denyTools is set and admits the rest', () => {
    const server = { denyTools: ['delete_project'] }

    expect(isToolAllowed(server, 'delete_project')).toBe(false)
    expect(isToolAllowed(server, 'search')).toBe(true)
  })

  test('lets deny win over allow when a tool appears in both', () => {
    // The lists overlap only by mistake, and the safe reading of a mistake is the
    // restrictive one: an operator who wrote a tool into denyTools meant to stop
    // it, and allow-wins would quietly resurrect it.
    const server = { allowTools: ['delete_project'], denyTools: ['delete_project'] }

    expect(isToolAllowed(server, 'delete_project')).toBe(false)
  })

  test('treats an empty allowTools as "no tools", distinct from an absent one', () => {
    // Reading [] as "unconstrained" would turn a deliberate lockdown into a
    // full opening — the exact inverse of the intent.
    expect(isToolAllowed({ allowTools: [] }, 'search')).toBe(false)
    expect(isToolAllowed({}, 'search')).toBe(true)
  })

  test('treats an empty denyTools as blocking nothing', () => {
    expect(isToolAllowed({ denyTools: [] }, 'search')).toBe(true)
  })

  test('matches tool names case-sensitively, as MCP defines them', () => {
    expect(isToolAllowed({ denyTools: ['Search'] }, 'search')).toBe(true)
    expect(isToolAllowed({ allowTools: ['Search'] }, 'search')).toBe(false)
  })
})
