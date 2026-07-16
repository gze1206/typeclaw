import type { McpServer } from '@/config/config'

// Per-server tool gating. `enabled` alone makes "connect this server" mean "trust
// every tool it will ever expose" — and an MCP server is third-party code whose
// tool list it controls at runtime, so that set is not knowable when the operator
// writes the config.
//
// Names are bare (`create_issue`), not namespaced (`linear__create_issue`): the
// lists live inside a server block, so the server is already fixed by context.
//
// No glob support, deliberately. Wildcards would add a matching contract
// (case-sensitivity, partial matches, `**`) to earn very little against tool
// lists that are short and enumerable. It can be added later; it cannot be
// removed later.
export function isToolAllowed(server: Pick<McpServer, 'allowTools' | 'denyTools'>, toolName: string): boolean {
  // Deny wins: the lists overlap only by operator error, and the safe reading of
  // an error is the restrictive one.
  if (server.denyTools?.includes(toolName) === true) return false
  // An absent allowTools means "unconstrained"; an EMPTY one means "nothing".
  // Collapsing those two would turn a deliberate lockdown into a full opening.
  if (server.allowTools !== undefined) return server.allowTools.includes(toolName)
  return true
}
