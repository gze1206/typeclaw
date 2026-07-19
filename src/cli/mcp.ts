import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { isCancel, log, note, text } from '@clack/prompts'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { defineCommand } from 'citty'

import { loadConfigSync } from '@/config'
import { findAgentDir, isInitialized } from '@/init'
import {
  clientRegistrationAcceptsRedirect,
  createFileMcpOAuthStore,
  describeCredentialState,
  listMcpCredentials,
  parseCodeInput,
  runMcpAuthFlow,
  resolveStaticMcpOAuthClient,
  TypeClawMcpOAuthProvider,
  type McpAuthCodeInput,
  type McpAuthFlowOutcome,
} from '@/mcp'
import { SecretsBackend } from '@/secrets'

import { c, done, errorLine } from './ui'

const DEFAULT_CALLBACK_PORT = 1456

const authSub = defineCommand({
  meta: {
    name: 'auth',
    description: 'authenticate an HTTP MCP server with OAuth',
  },
  args: {
    server: { type: 'positional', description: 'MCP server name from typeclaw.json', required: true },
    force: { type: 'boolean', description: 're-authenticate even if credentials already exist' },
    port: { type: 'string', description: `local OAuth callback port (default ${DEFAULT_CALLBACK_PORT})` },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const port = parsePort(args.port)
    if (port === null) {
      console.error(errorLine(`Invalid --port ${JSON.stringify(args.port)}: expected a number between 1 and 65535.`))
      process.exit(1)
    }
    const result = await runMcpAuthCommand(cwd, args.server, { force: args.force === true, port })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(
        result.status === 'already-authenticated'
          ? `MCP server "${args.server}" is already authenticated.`
          : `Authenticated MCP server "${args.server}".`,
      ),
      hints:
        result.status === 'already-authenticated'
          ? [{ label: 'Force a fresh login:', command: `typeclaw mcp auth ${args.server} --force` }]
          : [{ label: 'Apply the secrets.json change:', command: 'typeclaw reload' }],
    })
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'show configured MCP servers and OAuth credential state',
  },
  run() {
    const cwd = ensureAgentDir()
    const config = loadConfigSync(cwd)
    const credentials = listMcpCredentials(join(cwd, 'secrets.json'))
    if (config.mcpServers.length === 0) {
      console.log(c.dim('No MCP servers configured in typeclaw.json.'))
      return
    }
    const nameWidth = Math.max(4, ...config.mcpServers.map((server) => server.name.length))
    const typeWidth = 5
    console.log(c.dim(`${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(typeWidth)}  AUTH`))
    for (const server of config.mcpServers) {
      const type = server.url === undefined ? 'stdio' : 'http'
      const state = describeCredentialState(server, credentials[server.name])
      console.log(`${server.name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${state}`)
    }
  },
})

const logoutSub = defineCommand({
  meta: {
    name: 'logout',
    description: 'remove OAuth credentials for an MCP server',
  },
  args: {
    server: { type: 'positional', description: 'MCP server name from typeclaw.json', required: true },
  },
  run({ args }) {
    const cwd = ensureAgentDir()
    const removed = new SecretsBackend(join(cwd, 'secrets.json')).removeMcpCredentialSync(args.server)
    if (!removed) log.info(`No OAuth credentials found for MCP server "${args.server}".`)
    done({
      title: c.green(`Removed OAuth credentials for MCP server "${args.server}".`),
      hints: [{ label: 'Apply the secrets.json change:', command: 'typeclaw reload' }],
    })
  },
})

export const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'manage MCP server OAuth credentials',
  },
  subCommands: {
    auth: authSub,
    list: listSub,
    logout: logoutSub,
  },
})

// Thin shell: resolve config + I/O collaborators, then hand the decision logic to
// runMcpAuthFlow (src/mcp/auth-flow.ts), which is where the auth semantics and
// their tests live.
async function runMcpAuthCommand(
  cwd: string,
  serverName: string,
  opts: { force: boolean; port: number },
): Promise<McpAuthFlowOutcome> {
  const config = loadConfigSync(cwd)
  const server = config.mcpServers.find((candidate) => candidate.name === serverName)
  if (server === undefined) return { ok: false, reason: `MCP server "${serverName}" is not configured.` }
  const serverUrl = server.url
  if (serverUrl === undefined)
    return { ok: false, reason: `MCP server "${serverName}" is stdio-only; OAuth is HTTP-only.` }

  const secretsPath = join(cwd, 'secrets.json')
  const store = createFileMcpOAuthStore(secretsPath)
  const redirectUrl = `http://localhost:${opts.port}/callback`
  let staticClient
  try {
    staticClient = resolveStaticMcpOAuthClient(server, process.env, redirectUrl)
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }

  // A registration minted on another port would be rejected at the AS on exact
  // redirect_uri match, so drop it and let dynamic registration re-mint.
  const existing = await store.get(serverName)
  if (staticClient === undefined && !clientRegistrationAcceptsRedirect(existing?.client, redirectUrl)) {
    await store.invalidate(serverName, 'client')
  }

  let authorizationUrl: URL | undefined
  const provider = new TypeClawMcpOAuthProvider(serverName, store, {
    mode: 'host',
    redirectUrl,
    clientName: 'typeclaw',
    ...(staticClient === undefined ? {} : { staticClient }),
    onRedirect: (url) => {
      authorizationUrl = url
    },
  })

  let callback: CallbackServer
  try {
    callback = createCallbackServer(opts.port)
  } catch (cause) {
    if (isAddressInUse(cause)) {
      return {
        ok: false,
        reason: `OAuth callback port ${opts.port} is already in use. Free it, or pick another with: typeclaw mcp auth ${serverName} --port <port>`,
      }
    }
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }

  try {
    return await runMcpAuthFlow({
      serverName,
      force: opts.force,
      expectedState: () => provider.state(),
      authorize: (authOpts) =>
        auth(provider, {
          serverUrl,
          ...(authOpts?.authorizationCode === undefined ? {} : { authorizationCode: authOpts.authorizationCode }),
        }),
      authorizationUrl: () => authorizationUrl,
      onAuthorizationUrl: (url) => {
        renderAuthorizationUrl(serverName, url)
        openBrowserBestEffort(url)
      },
      waitForCode: () => waitForCode(callback),
      invalidateTokens: () => store.invalidate(serverName, 'tokens'),
      // A fresh store instance so this reads DISK, not the provider's in-memory
      // view — that is the whole point of the persistence check.
      readPersistedTokens: async () => (await createFileMcpOAuthStore(secretsPath).get(serverName))?.tokens,
    })
  } finally {
    callback.stop()
  }
}

function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === '') return DEFAULT_CALLBACK_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

type CallbackServer = { code: Promise<McpAuthCodeInput>; stop(): void }

// Race the browser callback against a manual paste. Whichever wins, the loser is
// cancelled: an abandoned clack prompt keeps stdin captured and the process alive.
async function waitForCode(callback: CallbackServer): Promise<McpAuthCodeInput> {
  const abort = new AbortController()
  try {
    return await Promise.race([callback.code, promptForCodeOrUrl(abort.signal)])
  } finally {
    abort.abort()
  }
}

function createCallbackServer(port: number): CallbackServer {
  let resolveCode!: (value: McpAuthCodeInput) => void
  const code = new Promise<McpAuthCodeInput>((resolve) => {
    resolveCode = resolve
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
      const parsed = parseCodeInput(url, 'callback')
      if (parsed === null) return new Response('Missing OAuth code', { status: 400 })
      resolveCode(parsed)
      return new Response('TypeClaw MCP OAuth complete. You can close this tab.')
    },
  })
  return { code, stop: () => server.stop(true) }
}

function isAddressInUse(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const code = (cause as { code?: unknown }).code
  if (code === 'EADDRINUSE') return true
  const message = cause instanceof Error ? cause.message : ''
  return message.includes('EADDRINUSE') || message.includes('address already in use')
}

function renderAuthorizationUrl(serverName: string, url: URL): void {
  note(
    [
      `Open this URL in your browser to authenticate MCP server "${serverName}".`,
      '',
      'If the browser cannot reach localhost after sign-in, copy the full redirect URL or code and paste it below.',
    ].join('\n'),
    'MCP OAuth',
  )
  console.log(url.toString())
  console.log('')
}

function openBrowserBestEffort(url: URL): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.toString()] : [url.toString()]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  child.unref()
}

async function promptForCodeOrUrl(signal: AbortSignal): Promise<McpAuthCodeInput> {
  const value = await text({
    message: 'After signing in, paste the code or full redirect URL:',
    placeholder: 'code, or http://localhost:1456/callback?code=...&state=...',
    signal,
  })
  if (isCancel(value)) throw new Error('OAuth login cancelled by user')
  const parsed = parseCodeInput(value, 'manual')
  if (parsed === null) throw new Error('OAuth callback did not include a code')
  return parsed
}
