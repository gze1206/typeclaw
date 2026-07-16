import { randomUUID } from 'node:crypto'

import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { sendHttp } from '@/hostd/client'
import type { Request } from '@/hostd/protocol'
import type { McpCredential, McpSlice } from '@/secrets/schema'
import { SecretsBackend } from '@/secrets/storage'

import { McpOAuthRequiredError } from './auth-state'

export type McpOAuthInvalidateScope = Parameters<NonNullable<OAuthClientProvider['invalidateCredentials']>>[0]

export interface McpOAuthStore {
  get(server: string): McpCredential | undefined | Promise<McpCredential | undefined>
  saveClient(server: string, client: OAuthClientInformationMixed): Promise<void>
  saveTokens(server: string, tokens: OAuthTokens): Promise<void>
  saveDiscovery(server: string, state: OAuthDiscoveryState): Promise<void>
  invalidate(server: string, scope: McpOAuthInvalidateScope): Promise<void>
}

export type TypeClawMcpOAuthProviderOptions = {
  mode: 'host' | 'container'
  redirectUrl: string
  clientName: string
  scope?: string
  onRedirect?: (url: URL) => void
}

export class TypeClawMcpOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined
  private oauthState: string | undefined

  constructor(
    private readonly serverName: string,
    private readonly store: McpOAuthStore,
    private readonly opts: TypeClawMcpOAuthProviderOptions,
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scope === undefined ? {} : { scope: this.opts.scope }),
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.get(this.serverName))?.client as OAuthClientInformationMixed | undefined
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.saveClient(this.serverName, info)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.get(this.serverName))?.tokens as OAuthTokens | undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.saveTokens(this.serverName, tokens)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.get(this.serverName))?.discovery as OAuthDiscoveryState | undefined
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.store.saveDiscovery(this.serverName, state)
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.verifier = verifier
  }

  async codeVerifier(): Promise<string> {
    if (this.verifier === undefined) throw new Error(`MCP server "${this.serverName}" OAuth verifier is missing`)
    return this.verifier
  }

  async state(): Promise<string> {
    this.oauthState ??= randomUUID()
    return this.oauthState
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    // No browser exists in the container, so the only way forward is a human on
    // the host. A typed error (rather than a bare Error) lets the dispatcher
    // classify this without matching on message text.
    if (this.opts.mode === 'container') throw new McpOAuthRequiredError(this.serverName)
    this.opts.onRedirect?.(url)
  }

  async invalidateCredentials(scope: McpOAuthInvalidateScope): Promise<void> {
    await this.store.invalidate(this.serverName, scope)
  }
}

export function createFileMcpOAuthStore(secretsPath: string): McpOAuthStore {
  const backend = new SecretsBackend(secretsPath)
  return {
    get(server) {
      return backend.readMcpCredentialSync(server)
    },
    async saveClient(server, client) {
      await patchMcp(backend, server, { client })
    },
    async saveTokens(server, tokens) {
      await patchMcp(backend, server, { tokens })
    },
    async saveDiscovery(server, discovery) {
      await patchMcp(backend, server, { discovery })
    },
    async invalidate(server, scope) {
      await invalidateMcp(backend, server, scope)
    },
  }
}

export type HostdMcpOAuthStoreOptions = {
  hostdUrl: string
  restartToken: string
  containerName: string
  secretsPath: string
}

export function createHostdMcpOAuthStore(options: HostdMcpOAuthStoreOptions): McpOAuthStore {
  const backend = new SecretsBackend(options.secretsPath)
  const write = async (server: string, credential: McpCredential): Promise<void> => {
    const request: Extract<Request, { kind: 'secrets-patch' }> = {
      kind: 'secrets-patch',
      containerName: options.containerName,
      patch: { mcp: { server, credential } },
    }
    const response = await sendHttp(request, { url: options.hostdUrl, token: options.restartToken })
    if (!response.ok) throw new Error(`secrets-patch failed: ${response.reason}`)
  }
  const patch = async (server: string, fieldPatch: McpCredential): Promise<void> => {
    await write(server, { ...backend.readMcpCredentialSync(server), ...fieldPatch })
  }
  return {
    get(server) {
      return backend.readMcpCredentialSync(server)
    },
    async saveClient(server, client) {
      await patch(server, { client })
    },
    async saveTokens(server, tokens) {
      await patch(server, { tokens })
    },
    async saveDiscovery(server, discovery) {
      await patch(server, { discovery })
    },
    async invalidate(server, scope) {
      const credential = invalidateCredential(backend.readMcpCredentialSync(server), scope)
      if (credential === undefined) return
      await write(server, credential)
    },
  }
}

async function patchMcp(backend: SecretsBackend, server: string, fieldPatch: McpCredential): Promise<void> {
  await backend.updateMcpAsync(async (mcp) => ({
    result: undefined,
    next: { ...mcp, [server]: { ...mcp[server], ...fieldPatch } },
  }))
}

async function invalidateMcp(backend: SecretsBackend, server: string, scope: McpOAuthInvalidateScope): Promise<void> {
  await backend.updateMcpAsync(async (mcp) => {
    const credential = invalidateCredential(mcp[server], scope)
    if (credential === undefined) return { result: undefined }
    return { result: undefined, next: { ...mcp, [server]: credential } }
  })
}

function invalidateCredential(
  credential: McpCredential | undefined,
  scope: McpOAuthInvalidateScope,
): McpCredential | undefined {
  if (credential === undefined) return undefined
  const next: McpCredential = { ...credential }
  if (scope === 'tokens' || scope === 'all') delete next.tokens
  if (scope === 'client' || scope === 'all') delete next.client
  if (scope === 'all') delete next.discovery
  return next
}

export function resolveContainerMcpOAuthStore(env: NodeJS.ProcessEnv, secretsPath: string): McpOAuthStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (hostdUrl && restartToken && containerName) {
    return createHostdMcpOAuthStore({ hostdUrl, restartToken, containerName, secretsPath })
  }
  return createFileMcpOAuthStore(secretsPath)
}

export function listMcpCredentials(secretsPath: string): McpSlice {
  return new SecretsBackend(secretsPath).tryReadMcpSync()
}
