# MCP Static OAuth Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any HTTP MCP server use an operator-provided OAuth client registration when its authorization server does not support DCR.

**Architecture:** Add an HTTP-only `oauth` configuration block, resolve its optional secret at the host/container boundary, and pass static OAuth client information to the existing MCP SDK provider. The provider returns static client data instead of persisted DCR registration; token and discovery persistence remain unchanged.

**Tech Stack:** TypeScript, Zod, MCP TypeScript SDK OAuth provider, Bun test runner.

## Global Constraints

- No `oauth` block preserves current DCR behavior.
- OAuth tokens remain in `secrets.json#mcp`; model bash never receives client secrets or tokens.
- `oauth` is HTTP-only and incompatible with static Authorization authentication.
- A configured redirect URI must exactly equal the callback URI selected by `typeclaw mcp auth`.
- Run `bun run typecheck`, `bun run lint`, and `bun run format` before every commit.

---

### Task 1: Model static OAuth registration in MCP configuration

**Files:**

- Modify: `src/config/config.ts:101-170`
- Test: `src/config/config.test.ts`

**Interfaces:**

- Produces: `McpServer.oauth?: { clientId: string; clientSecret?: Secret; redirectUri?: string; scope?: string }`.

- [ ] **Step 1: Write schema tests**

Add tests that parse an HTTP server with `oauth.clientId`, optional `{ env: 'MCP_CLIENT_SECRET' }`, redirect URI, and scope; reject an empty client ID, a stdio server with `oauth`, and an HTTP server that combines `oauth` with `bearerToken` or an Authorization header.

- [ ] **Step 2: Run the focused configuration tests**

Run: `bun test --parallel src/config/config.test.ts --test-name-pattern "MCP.*OAuth"`

Expected: FAIL because `oauth` is an unknown MCP server key.

- [ ] **Step 3: Add the strict `oauth` Zod object and cross-field validation**

Create `mcpOAuthSchema` with `clientId: z.string().trim().min(1)`, optional `clientSecret: secretFieldSchema`, optional HTTP(S) `redirectUri`, and optional non-empty `scope`. Add refinements requiring `server.url !== undefined` and no static Authorization mechanism when `server.oauth` is defined.

- [ ] **Step 4: Re-run focused configuration tests**

Run: `bun test --parallel src/config/config.test.ts --test-name-pattern "MCP.*OAuth"`

Expected: PASS.

### Task 2: Supply static client information to the OAuth provider

**Files:**

- Modify: `src/mcp/oauth.ts:27-80`
- Test: `src/mcp/oauth.test.ts`

**Interfaces:**

- Produces: `StaticMcpOAuthClient` and `TypeClawMcpOAuthProviderOptions.staticClient?: StaticMcpOAuthClient`.

- [ ] **Step 1: Write provider tests**

Add a test constructing `TypeClawMcpOAuthProvider` with `{ clientId: 'calendar-client', redirectUri: 'http://localhost:1456/callback', scope: 'calendar.events' }`. Assert `clientInformation()` returns `{ client_id: 'calendar-client', redirect_uris: ['http://localhost:1456/callback'] }`, `clientMetadata.scope` is `calendar.events`, and a stored DCR client cannot replace the configured client.

- [ ] **Step 2: Run the focused provider test**

Run: `bun test --parallel src/mcp/oauth.test.ts --test-name-pattern "static client"`

Expected: FAIL because the provider options have no `staticClient` field.

- [ ] **Step 3: Implement static-client precedence**

Define `StaticMcpOAuthClient` with `clientId`, optional `clientSecret`, optional `redirectUri`, and optional `scope`. Have `clientInformation()` return the configured client before consulting `McpOAuthStore`; include configured scope in `clientMetadata`; reject `saveClientInformation()` when a static client is configured so an SDK DCR response cannot overwrite configuration semantics.

- [ ] **Step 4: Re-run provider tests**

Run: `bun test --parallel src/mcp/oauth.test.ts`

Expected: PASS, including existing token and DCR persistence tests.

### Task 3: Resolve configuration at host and container OAuth entry points

**Files:**

- Modify: `src/mcp/oauth.ts`, `src/cli/mcp.ts:124-190`, `src/run/index.ts:260-277`
- Test: `src/cli/mcp.test.ts` or the existing MCP CLI test file; `src/run/index.test.ts`

**Interfaces:**

- Produces: `resolveStaticMcpOAuthClient(server: McpServer, env: NodeJS.ProcessEnv, callbackUrl: string): StaticMcpOAuthClient | undefined`.

- [ ] **Step 1: Write resolver and CLI redirect-mismatch tests**

Test that `{ oauth: { clientId: 'id', redirectUri: 'http://localhost:1456/callback' } }` resolves on port 1456, rejects a 1457 callback with an error naming both URIs, resolves `{ env: 'MCP_CLIENT_SECRET' }` from the supplied environment, and leaves a server without `oauth` undefined.

- [ ] **Step 2: Run the focused test**

Run: `bun test --parallel src/cli/mcp.test.ts --test-name-pattern "static OAuth|redirect URI"`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement one shared resolver and wire both paths**

Use `resolveSecret` to resolve `clientSecret`; set the callback to configured `redirectUri` or the caller's default callback; reject a configured URI that differs from the caller's callback. In `runMcpAuthCommand`, pass the resolved static client to `TypeClawMcpOAuthProvider` and skip stored-DCR invalidation for a static client. In `startAgentRuntime`, resolve the same client against `http://localhost:1456/callback` before creating the container-mode provider.

- [ ] **Step 4: Re-run focused auth and runtime tests**

Run: `bun test --parallel src/cli/mcp.test.ts src/mcp/oauth.test.ts src/run/index.test.ts`

Expected: PASS.

### Task 4: Document and verify the generalized flow

**Files:**

- Modify: `docs/content/docs/reference/typeclaw-json.mdx`
- Modify: `docs/content/docs/reference/cli.mdx`
- Test: relevant configuration, OAuth, CLI, and runtime suites.

- [ ] **Step 1: Document DCR fallback and static client configuration**

Add the `oauth` object to the `mcpServers` table and examples. State that `oauth` uses a pre-registered client, DCR remains the default when omitted, `clientSecret` is a `Secret`, and `--port` must match an explicit redirect URI.

- [ ] **Step 2: Run regression tests and repository checks**

Run:

```bash
bun test --parallel src/config/config.test.ts src/mcp/oauth.test.ts src/mcp/auth-flow.test.ts
bun run typecheck
bun run lint
bun run format
```

Expected: tests and typecheck pass; lint exits zero with only existing warnings.

- [ ] **Step 3: Commit the completed feature**

```bash
git add src/config/config.ts src/config/config.test.ts src/mcp/oauth.ts src/mcp/oauth.test.ts src/cli/mcp.ts src/run/index.ts docs/content/docs/reference/typeclaw-json.mdx docs/content/docs/reference/cli.mdx
git commit -m "feat: support static MCP OAuth clients"
```
