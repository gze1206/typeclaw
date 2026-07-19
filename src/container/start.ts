import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { expandMountPath, loadConfigSync, withDefaultPlugins, type Config, type PortForward } from '@/config'
import { commitGitignoreWithUntracks, untrackTrulyIgnoredFiles } from '@/git/reconcile-ignored'
import { commitSystemFile as commitSystemFileShared } from '@/git/system-commit'
import { send as sendToDaemon } from '@/hostd/client'
import { ensureModels as ensureHostModels } from '@/hostd/models'
import { homeRoot } from '@/hostd/paths'
import type { HttpInfoResult } from '@/hostd/protocol'
import { ensureDaemon, type EnsureDaemonResult } from '@/hostd/spawn'
import {
  autoUpgradeTypeclawDep,
  type AutoUpgradeOutcome,
  expectedInstalledAfterUpgrade,
  outcomeForcesInstall,
  outcomeRequiresForceInstall,
  readInstalledTypeclawVersionFromAgent,
} from '@/init/auto-upgrade'
import { resolveBaseImageVersion, resolveTypeclawSpec, typeclawCheckoutRoot } from '@/init/cli-version'
import { buildDockerfile, classifyDockerfileAppend, DOCKERFILE } from '@/init/dockerfile'
import { ensureDepsInstalled, type EnsureDepsResult } from '@/init/ensure-deps'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'
import { refreshPackageJson } from '@/init/packagejson'
import { reconcilePluginDeps } from '@/init/reconcile-plugin-deps'
import { runBunUpdate, type UpdateRunner } from '@/init/run-bun-install'
import { linkWindowsDevTypeclaw, resolveBunLinkedPackage, type RunBunLink } from '@/init/windows-dev-link'
import { isWindows } from '@/shared'
import { hostLocaleIsCjk } from '@/shared/host-locale'

import { CONTAINER_PORT, TUI_TOKEN_LABEL, findFreePort, isPortAllocatedError, resolveTuiToken } from './port'
import {
  buildxAvailable,
  classifyRmStderr,
  cleanupRunCorpse,
  containerNameFromCwd,
  defaultDockerExec,
  type DockerExec,
  type DockerExecResult,
  dockerBindMount,
  dockerConfigDir,
  imageTagFromCwd,
  isContainerNameConflict,
  isMissingDockerCredentialHelper,
  sanitizeDockerConfigJson,
  sanitizeDockerStderr,
  waitForRemoval,
} from './shared'
import { buildCrashReason, createVerifyRunning, type VerifyRunningFn } from './verify-running'

const PACKAGE_FILE = 'package.json'
const TYPECLAW_PACKAGE = 'typeclaw'
const DEV_SOURCE_CONTAINER_PATH = '/agent/node_modules/typeclaw'
const BUN_LOCK_FILE = 'bun.lock'
const DEPENDENCY_FILES = [PACKAGE_FILE, BUN_LOCK_FILE] as const
const ENV_FILE = '.env'
const COMPOSE_PROJECT = 'typeclaw'
const CONTAINER_HOSTD_HOST = 'host.docker.internal'
const HOST_GATEWAY_ALIAS = `${CONTAINER_HOSTD_HOST}:host-gateway`

const MOUNT_TARGET_PREFIX = '/agent/mounts'

export type StartPlan = {
  containerName: string
  imageTag: string
  buildContext: string
  dockerfile: string
  runArgs: string[]
  needsBuild: boolean
  hostPort: number
  tuiToken: string | null
}

export type PlanStartOptions = {
  cwd: string
  hostPort: number
  imageExists: boolean
  forceBuild?: boolean
  hostdControl?: HostDaemonControl
  publishHost?: string
  tuiToken?: string | null
  // Defaults to `process.platform`; tests inject it to exercise the native-
  // Windows dev-source mount branch without running on a Windows host.
  platform?: NodeJS.Platform
}

export type HostDaemonControl = {
  url: string
  token: string
  brokerToken: string
}

// Mirrors the `register` RPC's fields minus `kind`; shared by socket and
// in-process registration so both paths record the same registry entry.
export type HostDaemonRegisterPayload = {
  containerName: string
  cwd: string
  restartToken: string
  wsHostPort: number
  portForward: PortForward
  brokerToken: string
}

// Injected only on the daemon-owned restart path (reuseCurrentHostDaemon).
// The daemon registers the container in-process and reports its own HTTP port,
// so the restart skips the `http-info`/`register` self-RPCs — those round-trips
// can time out under IPC congestion and silently drop the TYPECLAW_HOSTD_* env
// triple, booting a container whose hostd-bridged adapters can't construct.
export type CurrentHostDaemon = {
  httpPort: number
  register: (payload: HostDaemonRegisterPayload) => Promise<{ ok: true } | { ok: false; reason: string }>
}

export type StartOptions = {
  cwd: string
  preferredHostPort: number
  forceBuild?: boolean
  exec?: DockerExec
  // Test seam: allows tests to inject a deterministic port allocator. In
  // production we go through the real kernel via `findFreePort`.
  allocatePort?: (preferred: number) => Promise<number>
  cliEntry?: string
  // Hostd's supervisor restart callback already runs inside the daemon process.
  // Reusing that daemon avoids a self-shutdown when disk source has drifted.
  reuseCurrentHostDaemon?: boolean
  // Set by hostd's supervisor restart wrapper. When present, registration goes
  // through the daemon in-process (no socket round-trips), so the env triple is
  // injected from known-good values even under IPC congestion. See type docs.
  currentHostDaemon?: CurrentHostDaemon
  ensureDeps?: (cwd: string, opts?: { force?: boolean }) => Promise<EnsureDepsResult>
  // Test seam for host embedding model provisioning. Production callers use
  // the file-locked host cache downloader.
  ensureModels?: () => Promise<void>
  // Test seam for the typeclaw-version auto-upgrade. Production callers omit
  // this and get the real autoUpgradeTypeclawDep (which reads the CLI's own
  // package.json). Tests inject a stub to simulate `bun -g update typeclaw`
  // having bumped the CLI without touching the agent folder.
  autoUpgrade?: (cwd: string) => Promise<AutoUpgradeOutcome>
  // Test seam for the auto-upgrade-triggered registry resolution. Defaults
  // to `bun update typeclaw --latest`. Cannot be `runBunInstall` — see the
  // module header in src/init/auto-upgrade.ts for why install doesn't move
  // an already-locked in-range dep.
  forceBunUpdate?: UpdateRunner
  // Test seam for the post-install verification. Reads the version actually
  // present in <agent>/node_modules/typeclaw/package.json after the upgrade
  // install completes. Defaults to readInstalledTypeclawVersionFromAgent.
  // Verification is mandatory: `bun update` can succeed (exit 0) but still
  // resolve to an older version than expected if the registry has issues
  // or the spec resolution surprises us; we MUST refuse to proceed to
  // refreshDockerfile in that case, otherwise the Dockerfile pins a stale
  // base image and the build either fails or runs against the wrong runtime.
  readInstalledVersion?: (cwd: string) => string | null
  // Post-`docker run` verifier. `docker run -d` returns exit 0 the moment the
  // container is created, even if its entrypoint crashes milliseconds later.
  // The default verifier polls `docker inspect` for 1.5s and converts crashes
  // (or unrecoverable daemon errors) into start failures, with the crashed
  // container's `docker logs` captured into the failure reason. Pass a custom
  // function to override the wait window or to bypass verification entirely
  // (e.g. a no-op `async () => ({ ok: true })` for unit tests that don't care).
  verifyRunning?: VerifyRunningFn
  // Test seam for the native-Windows dev-link step run before ensureDeps when a
  // local-checkout reconcile emits `link:typeclaw`. Defaults to `bun link` in
  // the checkout. Mirrors init's `runBunLink` seam.
  runBunLink?: RunBunLink
  // Defaults to `process.platform`; tests inject it to exercise the
  // native-Windows dev-link reconcile path off a non-Windows runner.
  platform?: NodeJS.Platform
}

export type HostDaemonStatus =
  | { state: 'registered' }
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

export type StartResult =
  | {
      ok: true
      plan: StartPlan
      containerId: string
      built: boolean
      hostPort: number
      tuiToken: string | null
      hostd: HostDaemonStatus
      // True when the container was already running and start() became a no-op.
      // Callers that want to distinguish "I just launched it" from "it was up
      // already" (CLI output, compose summaries) gate on this flag. False on
      // every fresh launch, including the post-stale-corpse `--rm` recovery
      // path — that one rebuilds the container from scratch.
      alreadyRunning: boolean
      autoUpgrade: AutoUpgradeOutcome
      // npm plugins dropped this start because their package 404s in the
      // registry. Non-fatal by design: a typo'd or unpublished plugin warns
      // instead of blocking the launch.
      skippedPlugins: string[]
      // Non-fatal warnings from docker.file.append: unsafe lines stripped from
      // the generated Dockerfile, plus warn-but-allow lines (curl|bash, remote
      // ADD). Surfaced by the CLI so a stripped line is never a silent no-op.
      dockerfileWarnings: string[]
    }
  | { ok: false; reason: string }

export async function start({
  cwd,
  preferredHostPort,
  forceBuild = false,
  exec = defaultDockerExec,
  allocatePort = findFreePort,
  cliEntry,
  reuseCurrentHostDaemon = false,
  currentHostDaemon,
  ensureDeps = (dir, opts) => ensureDepsInstalled({ cwd: dir, ...opts }),
  ensureModels = ensureHostModels,
  autoUpgrade = (dir) => autoUpgradeTypeclawDep({ cwd: dir, localSpec: resolveTypeclawSpec(dir) }),
  forceBunUpdate = runBunUpdate,
  readInstalledVersion = readInstalledTypeclawVersionFromAgent,
  verifyRunning = createVerifyRunning({ exec }),
  runBunLink,
  platform = process.platform,
}: StartOptions): Promise<StartResult> {
  try {
    const containerName = containerNameFromCwd(cwd)
    const imageTagValue = imageTagFromCwd(cwd)

    // Probe container state BEFORE refreshing Dockerfile/.gitignore: when the
    // container is already running, start() is a no-op and must not produce
    // side effects (template writes, .gitignore commits, package.json migration)
    // that would surprise a user invoking `compose start` against a partially-up
    // tree.
    const state = await inspectContainer(exec, containerName)
    if (state.exists && state.running) {
      return await reportAlreadyRunning(exec, cwd, containerName)
    }

    // TypeClaw owns Dockerfile, .gitignore, and the bun-workspaces shape of
    // package.json. Refresh them from the current CLI templates on every fresh
    // start (not just --build) so version drift between the agent folder and
    // the CLI is corrected automatically. The Dockerfile is gitignored
    // (regenerated on every start, never tracked), so only .gitignore and the
    // package.json migration land in git. The package.json migration is
    // one-shot and idempotent — once `workspaces` is set, refreshPackageJson
    // is a no-op, so users who never edit their agent folder pay zero cost on
    // subsequent starts and users who customized `workspaces` are not clobbered.
    //
    // typeclaw.json migration is NOT triggered explicitly here — it follows
    // the disk rewrite via persistMigratedConfig (src/config/config.ts), so
    // every entry point that reads typeclaw.json (host CLI, hostd daemon,
    // container runtime) also produces the commit. start() therefore only
    // needs to orchestrate the .gitignore / package.json side; the
    // refreshGitignore call below reads typeclaw.json and will incidentally
    // trigger the migration commit if the file was legacy.
    await refreshGitignore(cwd)
    const pkgRefresh = await refreshPackageJson(cwd)
    const { untracked } = await untrackTrulyIgnoredFiles(cwd, (await loadTypeclawConfig(cwd)).git.ignore.append)
    if (untracked.length > 0) {
      await commitGitignoreWithUntracks(cwd, GITIGNORE_FILE, untracked, 'Untrack newly-ignored files')
    } else {
      await commitSystemFile(cwd, GITIGNORE_FILE, 'Update .gitignore')
    }
    if (pkgRefresh.changed) {
      await commitSystemFile(cwd, pkgRefresh.files, 'Enable bun workspaces (packages/*)')
    }

    // Align the agent's typeclaw dep with the global CLI version BEFORE
    // ensureDeps runs. The classic regression this prevents: `bun -g update
    // typeclaw` bumps the global CLI but the agent's node_modules/typeclaw
    // stays pinned to whatever was installed at init time. refreshDockerfile
    // then pins FROM ghcr/typeclaw-base:<old-version> and the docker build
    // either fails (image never published) or runs against a stale runtime.
    //
    // We use `bun update typeclaw --latest` (NOT `bun install`) because plain
    // install honors the lockfile and is a no-op when the lockfile already
    // satisfies the declared spec — which is the canonical regression case
    // (lockfile pins 0.1.0, spec says ^0.1.0, CLI is 0.1.2; install does
    // nothing, update force-resolves to 0.1.2).
    //
    // After the update we MUST verify the installed version actually matches
    // the upgrade target. `bun update` can exit 0 but resolve to a stale
    // version (registry hiccups, surprising spec resolution). If verification
    // fails we abort before refreshDockerfile so we never pin a stale base
    // image to a fresh container build.
    const upgrade = await autoUpgrade(cwd)
    const upgradeCommitMessage = commitMessageForAutoUpgrade(upgrade)
    // Any agent on a `link:typeclaw` spec (native-Windows dev) needs the
    // checkout registered with `bun link` BEFORE ensureDeps, exactly as init's
    // maybeLinkWindowsDevTypeclaw does — otherwise bun can't resolve the link:
    // spec. We gate on the EFFECTIVE on-disk spec, not the transition outcome:
    // a prior start that wrote `link:` but failed/interrupted before
    // registering would otherwise leave the next start (which sees the spec
    // already local → skipped-dev-mode) reaching ensureDeps unregistered.
    // `bun link` is idempotent, so re-running it on every link: start is safe
    // and self-heals that gap. No-op off Windows (linkWindowsDevTypeclaw → null).
    // True when this is a native-Windows agent on a `link:typeclaw` spec, after
    // (re)registering its checkout. Forces ensureDeps below: ensureDeps' drift
    // detector only looks for MISSING dep names, so a stale npm-installed
    // node_modules/typeclaw left by an interrupted relink would make it skip the
    // install and leave the agent on the old runtime. Forcing materializes the
    // link. Off Windows / non-link specs this stays false.
    let registeredWindowsLink = false
    if ((await readTypeclawDepSpec(cwd))?.startsWith('link:') === true) {
      const checkout = typeclawCheckoutRoot()
      if (checkout !== null) {
        const linked = await linkWindowsDevTypeclaw(checkout, {
          platform,
          ...(runBunLink !== undefined ? { runBunLink } : {}),
        })
        registeredWindowsLink = linked !== null
      }
    }
    if (outcomeForcesInstall(upgrade)) {
      const forced = await forceBunUpdate(cwd, 'typeclaw')
      if (!forced.ok) {
        return { ok: false, reason: `typeclaw auto-upgrade install failed: ${forced.reason}` }
      }
      const expected = expectedInstalledAfterUpgrade(upgrade)
      const installedAfter = readInstalledVersion(cwd)
      if (expected !== null && (installedAfter === null || !installedReachesTarget(installedAfter, expected))) {
        return {
          ok: false,
          reason: `typeclaw auto-upgrade verification failed: bun update reported success but <agent>/node_modules/typeclaw is ${installedAfter ?? 'missing'} (expected >= ${expected}). Refusing to build a Docker image against a stale runtime.`,
        }
      }
    }

    // Run `bun install` BEFORE the dependency-drift commit so the lockfile
    // changes the install produces are caught by the same commit. Without
    // this, upgrading the typeclaw CLI to a version that adds a new dep
    // (e.g. a new transitive dep that needs hoisting) leaves the agent's
    // node_modules/ partially populated. The container then crashes with
    // `Cannot find package 'x'` because the agent folder is bind-mounted into
    // /agent and the container has no node_modules of its own.
    //
    // Force-reinstall ONLY when --build is set AND typeclaw is declared via
    // a local link. Bun's file-dep cache otherwise serves stale source on
    // subsequent installs (PR #243 dogfooding wasted three rebuilds + a
    // manual version bump before this gate existed). Registry-spec users
    // skip the force path because their install is already cache-correct.

    // Materialize typeclaw.json#plugins into package.json BEFORE ensureDeps so
    // the drift detector below sees the newly-written deps as missing and
    // installs them in the same pass. This makes the plugin list a single
    // source of truth: the user edits typeclaw.json and never touches
    // package.json. The agent cannot abuse this to install arbitrary host code —
    // the security plugin's `pluginAddition` guard gates writes to the plugins
    // field at owner/trusted trust, so by the time this host-side step runs the
    // field is trustworthy by construction.
    const pluginReconcile = await reconcilePluginDeps({
      cwd,
      plugins: withDefaultPlugins((await loadTypeclawConfig(cwd)).plugins),
    }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as const)
    if ('error' in pluginReconcile) {
      return { ok: false, reason: `plugin dependency reconcile failed: ${pluginReconcile.error}` }
    }

    // Force install when reconcile rewrote package.json. ensureDeps' drift
    // detector only checks for MISSING dependency names, so a managed plugin's
    // version bump (dir already present) or a removal (stale dir left behind)
    // would otherwise leave bun.lock/node_modules out of sync with the
    // reconciled package.json.
    const forceDepsReinstall =
      (forceBuild && (await hasLocallyLinkedTypeclawDep(cwd))) ||
      pluginReconcile.changed ||
      outcomeRequiresForceInstall(upgrade) ||
      registeredWindowsLink
    const deps = await ensureDeps(cwd, { force: forceDepsReinstall })
    if (!deps.ok) {
      return { ok: false, reason: `dependency install failed: ${deps.reason}` }
    }
    await commitSystemFile(cwd, DEPENDENCY_FILES, upgradeCommitMessage ?? 'Update dependencies')
    // Probe buildx up front so the Dockerfile we write matches the builder we
    // will use. buildx present -> emit the BuildKit Dockerfile and build with
    // `docker buildx build` (fast, cache mounts honored). buildx absent -> emit
    // the BuildKit-stripped variant and fall back to legacy `docker build`, so
    // `typeclaw start` still succeeds (just without cross-build apt/bun caches).
    const hasBuildx = await buildxAvailable(exec)
    // Dockerfile refresh AFTER ensureDeps so the version pin in the FROM
    // line resolves against the agent's installed node_modules/typeclaw —
    // ensures the base image's CLI version matches the runtime the
    // container will actually load.
    const dockerfileRefresh = await refreshDockerfile(cwd, { buildKit: hasBuildx })

    // The container embedder runs with local_files_only, so the model must
    // already be on the host's ~/.typeclaw/models cache before the container
    // boots. Kick the download off here (idempotent + file-locked) so it
    // overlaps the docker build, then await it just before `docker run`. The
    // `.catch` swallow only keeps an early return between here and the await
    // from logging an unhandled rejection; the real error is surfaced below.
    const modelsReady = ensureModels()
    modelsReady.catch(() => {})

    if (state.exists) {
      // Container holds the name but is not running. Without `--rm`, this is
      // now the normal post-stop / post-crash state: the corpse stays around
      // for `docker logs` so users can debug a crashed agent. Force-remove
      // before `docker run --name <same>` so the new launch doesn't collide
      // on the name. See classifyRmStderr for the benign-failure contract:
      // 'gone' means the name is already free; 'in-progress' means Docker is
      // still draining a prior removal and we must wait it out before docker
      // run, or we'd hit `Conflict. The container name "/<name>" is already
      // in use` even though our rm "succeeded".
      //
      // Even when `docker rm -f` returns exit 0 we MUST wait for the inspect
      // probe to confirm the name is free. On OrbStack (and occasionally
      // Docker Desktop) under concurrent load — the canonical case being
      // `typeclaw compose restart`, which fires N parallel stop→start pairs
      // — `rm -f` acknowledges the request before the daemon has finished
      // draining the removal. The container is still listed by `docker ps -a`
      // (with the same ID Docker reports back in the "Conflict. The container
      // name … is already in use by container <ID>" error) for tens to
      // hundreds of milliseconds, and `docker run --name <same>` issued
      // inside that window deterministically loses the race. waitForRemoval
      // returns on the first inspect probe in the happy path (one extra
      // `docker inspect` per start when there was a corpse), so the cost
      // here is bounded and small.
      const rm = await exec(['rm', '-f', containerName])
      if (rm.exitCode !== 0) {
        const kind = classifyRmStderr(rm.stderr)
        if (kind === null) {
          return {
            ok: false,
            reason: `Container ${containerName} exists but is not running, and could not be removed: ${sanitizeDockerStderr(rm.stderr) || 'no stderr'}`,
          }
        }
        if (kind === 'in-progress' && !(await waitForRemoval(exec, containerName))) {
          return {
            ok: false,
            reason: `Container ${containerName} is still being removed by docker after 10s; refusing to docker run --name to avoid a name conflict.`,
          }
        }
      } else if (!(await waitForRemoval(exec, containerName))) {
        return {
          ok: false,
          reason: `Container ${containerName} is still being removed by docker after 10s; refusing to docker run --name to avoid a name conflict.`,
        }
      }
    }

    const imageExisted = await imageExists(exec, imageTagValue)

    // First attempt uses the user's preferred host port (8973 by default, or
    // whatever they passed via --port / typeclaw.json). If it's already bound
    // we fall through to a kernel-assigned ephemeral port. The container's
    // internal port stays fixed at CONTAINER_PORT regardless.
    let hostPort = await allocatePort(preferredHostPort)

    // Register AFTER port allocation so the daemon's portbroker has the right
    // wsHostPort. Re-register on TOCTOU retry below if the port changes.
    let hostd: PreparedHostDaemonStatus = cliEntry
      ? await registerWithDaemon({ cwd, containerName, cliEntry, hostPort, reuseCurrentHostDaemon, currentHostDaemon })
      : { state: 'disabled' as const }
    let hostdControl = hostd.state === 'registered' ? hostd.control : undefined

    const publishHost = await resolvePublishHost(exec)
    const tuiToken = randomBytes(32).toString('base64url')
    let plan = await planStart({
      cwd,
      hostPort,
      imageExists: imageExisted,
      forceBuild: forceBuild || dockerfileRefresh.changed,
      hostdControl,
      publishHost,
      tuiToken,
      platform,
    })

    let built = false
    if (plan.needsBuild) {
      const buildOk = await runImageBuild({
        exec,
        cwd,
        imageTag: plan.imageTag,
        buildContext: plan.buildContext,
        hasBuildx,
      })
      if (!buildOk) {
        await cleanupHostDaemonRegistration(containerName, hostd)
        return { ok: false, reason: 'docker build failed' }
      }
      built = true
    }

    try {
      await modelsReady
    } catch (error) {
      await cleanupHostDaemonRegistration(containerName, hostd)
      return {
        ok: false,
        reason: `embedding model unavailable; ensure network access on first start or a populated model cache: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let run = await execRunWithConflictRetry(exec, plan.runArgs, cwd, containerName)

    // TOCTOU: another process may have grabbed the port between our probe and
    // `docker run`, or the kernel-assigned port may itself have been claimed.
    // Treat docker as the authority and retry once with a fresh ephemeral port.
    // Skip rebuild on retry: the image is already on disk from the first attempt.
    // Re-register so the daemon's broker resolver returns the new port.
    //
    // Failed `docker run -p` calls can leave a created-but-not-running
    // container record behind: depending on daemon version, Docker creates
    // the container before binding the port, so the bind failure aborts
    // start but leaves the corpse holding the name. The port-TOCTOU retry
    // would then re-run `docker run --name <same>` and hit a name conflict
    // against that corpse. Clean it up before the retry so the new run sees
    // a free name. cleanupRunCorpse is safe (only force-removes non-running
    // same-name containers) and a no-op when the name is already free.
    if (run.exitCode !== 0 && isPortAllocatedError(run.stderr)) {
      const cleanup = await cleanupRunCorpse(exec, containerName)
      if (cleanup === 'running') {
        await cleanupHostDaemonRegistration(containerName, hostd)
        return {
          ok: false,
          reason: `docker run failed (port bind) but cleanup found ${containerName} now running — refusing to retry against a live container.`,
        }
      }
      if (cleanup === 'stuck') {
        await cleanupHostDaemonRegistration(containerName, hostd)
        return {
          ok: false,
          reason: `docker run failed (${sanitizeDockerStderr(run.stderr) || 'port bind'}) and the failed-run corpse for ${containerName} did not disappear within 10s; refusing to retry.`,
        }
      }
      hostPort = await allocatePort(0)
      if (cliEntry) {
        hostd = await registerWithDaemon({
          cwd,
          containerName,
          cliEntry,
          hostPort,
          reuseCurrentHostDaemon,
          currentHostDaemon,
        })
        hostdControl = hostd.state === 'registered' ? hostd.control : undefined
      }
      plan = await planStart({
        cwd,
        hostPort,
        imageExists: true,
        forceBuild: false,
        hostdControl,
        publishHost,
        tuiToken,
        platform,
      })
      run = await execRunWithConflictRetry(exec, plan.runArgs, cwd, containerName)
    }

    if (run.exitCode !== 0) {
      await cleanupHostDaemonRegistration(containerName, hostd)
      return { ok: false, reason: `docker run failed: ${sanitizeDockerStderr(run.stderr) || 'no stderr'}` }
    }

    const containerId = run.stdout.trim()

    const verification = await verifyRunning(containerName)
    if (!verification.ok) {
      await cleanupHostDaemonRegistration(containerName, hostd)
      return { ok: false, reason: buildCrashReason(containerName, verification) }
    }

    return {
      ok: true,
      plan,
      containerId,
      built,
      hostPort,
      tuiToken,
      hostd: stripHostDaemonControl(hostd),
      alreadyRunning: false,
      autoUpgrade: upgrade,
      skippedPlugins: pluginReconcile.skipped,
      dockerfileWarnings: dockerfileRefresh.warnings,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function commitMessageForAutoUpgrade(outcome: AutoUpgradeOutcome): string | null {
  if (outcome.kind === 'spec-rewritten') return `Upgrade typeclaw to ${outcome.to}`
  if (outcome.kind === 'reinstall-needed') return `Upgrade typeclaw to ${outcome.to}`
  if (outcome.kind === 'relinked-to-local') return `Link typeclaw to local checkout (${outcome.to})`
  return null
}

function installedReachesTarget(installed: string, target: string): boolean {
  const ai = installed.match(/^(\d+)\.(\d+)\.(\d+)$/)
  const at = target.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!ai || !at) return false
  for (let i = 1; i <= 3; i++) {
    const a = Number.parseInt(ai[i]!, 10)
    const t = Number.parseInt(at[i]!, 10)
    if (a !== t) return a > t
  }
  return true
}

export async function planStart({
  cwd,
  hostPort,
  imageExists,
  forceBuild = false,
  hostdControl,
  publishHost = '127.0.0.1',
  tuiToken = null,
  platform = process.platform,
}: PlanStartOptions): Promise<StartPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const devSourcePath = await detectDevSource(cwd)
  const cfg = await loadTypeclawConfig(cwd)
  const mounts = cfg.mounts

  // No `--rm`: a crashed container's logs MUST survive past exit so users can
  // debug the failure. `typeclaw stop` removes the container explicitly, and
  // the start() preflight force-removes any lingering corpse before the next
  // launch — so the only state Docker ever sees in `docker ps -a` is either
  // a running container or one the user has not started again yet.
  //
  // `--shm-size=2g` is mandatory for the bundled Chrome (agent-browser) to
  // survive heavy pages. Docker's default /dev/shm is 64MB; Chrome uses
  // shared memory for the renderer process and silently crashes mid-load
  // on any site with a large DOM or non-trivial WebGL. The crash surfaces
  // as a blank page or "target closed" with no clear cause — easy to
  // misattribute to bot detection. 2g matches the Playwright/Puppeteer
  // canonical recommendation and is a memory cap, not an allocation (only
  // used pages count against the host).
  // `seccomp=unconfined` lets `bwrap(1)` (installed in baseline; see
  // BASELINE_APT_PACKAGES in src/init/dockerfile.ts) create user/pid/mount
  // namespaces from inside the container. Docker's default seccomp profile
  // rejects `unshare(CLONE_NEWUSER)` and `clone(CLONE_NEWUSER)` for
  // non-privileged containers, which is the right default for multi-tenant
  // hosts (Kubernetes nodes, CI runners) but wrong for typeclaw: the outer
  // container is a single-tenant trust boundary — the user trusts everything
  // inside it equally, the .env and agent folder are already mounted in —
  // so the multi-tenant protections seccomp adds are not load-bearing for
  // typeclaw's threat model. The per-tool sandbox bwrap builds for subagents
  // IS the real boundary against prompt-injected commands; that boundary is
  // what `--security-opt seccomp=unconfined` exists to enable. See
  // `docs/internals/sandbox.mdx` for the full rationale including why
  // `--cap-add=SYS_ADMIN` was rejected as an alternative (narrower in
  // syscalls but strictly worse in capability semantics).
  const runArgs = [
    'run',
    '-d',
    '--name',
    containerName,
    '--shm-size=2g',
    '--security-opt',
    'seccomp=unconfined',
    '-p',
    `${publishHost}:${hostPort}:${CONTAINER_PORT}`,
  ]

  // Docker's default AppArmor profile can deny bwrap's recursive mount
  // propagation setup (`Failed to make / slave`) even after seccomp is disabled.
  // AppArmor is a Linux LSM, and Docker daemons without it reject this option,
  // so emit it only for a Linux host. The outer container remains single-tenant;
  // bwrap's per-tool namespace is the model-command boundary.
  if (platform === 'linux') runArgs.push('--security-opt', 'apparmor=unconfined')

  // Network egress filter: when `typeclaw.json#network.blockInternal` is true,
  // grant the container CAP_NET_ADMIN at boot so the entrypoint shim can
  // install iptables OUTPUT rules. The shim drops the capability from the
  // bounding set via setpriv before exec'ing the agent — see the shim source
  // in src/init/dockerfile.ts for the full handoff. The `-e` flag is what
  // tells the shim to take the on-path; absent or set to anything other than
  // "1", the shim is a no-op. `autoAllowResolvers` / `allow` envs are only
  // emitted on the on-path because the shim's off-path doesn't read them;
  // `TYPECLAW_NETWORK_ALLOW` is comma-joined to match the shim's `IFS=','`
  // loop, and CIDR validation already happened at config parse time.
  if (cfg.network.blockInternal) {
    runArgs.push('--cap-add=NET_ADMIN', '-e', 'TYPECLAW_NETWORK_BLOCK_INTERNAL=1')
    runArgs.push('-e', `TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=${cfg.network.autoAllowResolvers ? '1' : '0'}`)
    if (cfg.network.allow.length > 0) {
      runArgs.push('-e', `TYPECLAW_NETWORK_ALLOW=${cfg.network.allow.join(',')}`)
    }
  }

  // sandbox.realProc (default FALSE) opts into the per-tool bwrap sandbox's
  // 'real-proc' strategy (src/sandbox/build.ts), which prefixes the sandbox with
  // `unshare --pid --fork --mount --mount-proc`. Mounting a fresh procfs for the
  // new PID namespace needs real CAP_SYS_ADMIN — seccomp=unconfined alone is not
  // enough (it only unblocks the unshare/clone SYSCALLS; the kernel still
  // rejects mount(2) of proc without the capability). So the grant is gated on
  // the flag and is OFF by default: external-package execution (`bunx agent-*`)
  // no longer needs it — the default 'proc-bind' strategy gives the runner real
  // /proc without any outer capability (see docs/internals/sandbox.mdx). Setting
  // realProc:true adds the stricter PID-isolation posture at the cost of this
  // broad "new root" grant. The container-side strategy resolution still probes
  // whether the mount actually works (canMountRealProc) and falls back to
  // proc-bind on runtimes where the cap is a no-op (e.g. OrbStack), so this grant
  // is necessary-but-not-sufficient by design. Placed before the image tag (like
  // --cap-add=NET_ADMIN) so docker applies it at run time.
  if (cfg.sandbox.realProc) {
    runArgs.push('--cap-add=SYS_ADMIN')
  }

  // sandbox.symlinks: the entrypoint shim creates `from -> /agent/<to>` at the
  // real container HOME for runtime-owned processes. Model-driven bash creates
  // its corresponding link at the bwrap HOME via src/sandbox/build.ts. Passed
  // as base64-encoded JSON because `from`/`to`
  // are arbitrary operator strings — base64 sidesteps every shell-metachar and
  // env-quoting hazard; the shim decodes + JSON-parses it with bun. Omitted when
  // empty so the common case adds no env clutter and the shim's loop never runs.
  if (cfg.sandbox.symlinks.length > 0) {
    const encoded = Buffer.from(JSON.stringify(cfg.sandbox.symlinks), 'utf8').toString('base64')
    runArgs.push('-e', `TYPECLAW_SANDBOX_SYMLINKS=${encoded}`)
  }

  if (hostdControl) {
    runArgs.push('--add-host', HOST_GATEWAY_ALIAS)
  }

  for (const [key, value] of Object.entries(composeLabels(cwd, containerName))) {
    runArgs.push('--label', `${key}=${value}`)
  }
  if (tuiToken !== null) {
    runArgs.push('--label', `${TUI_TOKEN_LABEL}=${tuiToken}`, '-e', `TYPECLAW_TUI_TOKEN=${tuiToken}`)
  }

  if (existsSync(join(cwd, ENV_FILE))) {
    runArgs.push('--env-file', join(cwd, ENV_FILE))
  }

  // Propagate the host timezone so cron schedules in typeclaw.json (and
  // cron.json jobs without an explicit `timezone`) fire at wall-clock times
  // the user expects. oven/bun:1-slim ships tzdata, so just setting TZ is
  // enough — no Dockerfile change required.
  const hostTz = resolveHostTimezone()
  if (hostTz) {
    runArgs.push('-e', `TZ=${hostTz}`)
  }

  // The agent's `restart` tool needs to identify itself to hostd. Inside the
  // container, cwd is `/agent` and basename(cwd) loses the host folder name,
  // so we cannot derive containerName from cwd at runtime. Inject it as an
  // env var — same way TZ is plumbed.
  runArgs.push('-e', `TYPECLAW_CONTAINER_NAME=${containerName}`)

  if (hostdControl) {
    runArgs.push('-e', `TYPECLAW_HOSTD_URL=${hostdControl.url}`)
    runArgs.push('-e', `TYPECLAW_HOSTD_TOKEN=${hostdControl.token}`)
    runArgs.push('-e', `TYPECLAW_HOSTD_BROKER_TOKEN=${hostdControl.brokerToken}`)
  }

  runArgs.push(...dockerBindMount({ src: cwd, dst: '/agent' }))

  if (shouldMirrorDevSource(devSourcePath, cwd, platform)) {
    runArgs.push(...dockerBindMount({ src: devSourcePath, dst: devSourcePath, readonly: true }))
  } else if (shouldMountWindowsDevSource(devSourcePath, cwd, platform)) {
    runArgs.push(...dockerBindMount({ src: devSourcePath, dst: DEV_SOURCE_CONTAINER_PATH, readonly: true }))
  }

  for (const mount of mounts) {
    const hostPath = expandMountPath(mount.path, cwd)
    const target = `${MOUNT_TARGET_PREFIX}/${mount.name}`
    runArgs.push(...dockerBindMount({ src: hostPath, dst: target, readonly: mount.readOnly }))
  }

  // Shared model cache mount for embeddings. Vector memory is always on, and
  // the embedder runs with local_files_only inside the container.
  runArgs.push(...dockerBindMount({ src: join(homeRoot(), 'models'), dst: '/opt/models', readonly: true }))
  runArgs.push('-e', 'TYPECLAW_MODEL_CACHE=/opt/models')

  runArgs.push(imageTag)

  return {
    containerName,
    imageTag,
    buildContext: cwd,
    dockerfile: join(cwd, DOCKERFILE),
    runArgs,
    needsBuild: forceBuild || !imageExists,
    hostPort,
    tuiToken,
  }
}

async function resolvePublishHost(exec: DockerExec): Promise<string> {
  const result = await exec(['version', '--format', '{{.Server.Platform.Name}}'])
  if (result.exitCode === 0 && result.stdout.toLowerCase().includes('docker desktop')) return '0.0.0.0'
  return '127.0.0.1'
}

// The `changed` return drives auto-rebuild in start() so users don't need to
// pass `--build` after a CLI upgrade or after editing `typeclaw.json#docker.*`.
// Comparing rendered contents (rather than tracking a separate state file) is
// the cheapest correct signal: the build context for `docker build` is the
// Dockerfile itself, so equal contents definitionally produce an equivalent
// image.
export async function refreshDockerfile(
  cwd: string,
  opts: { buildKit?: boolean } = {},
): Promise<{ changed: boolean; warnings: string[] }> {
  const cfg = await loadTypeclawConfig(cwd)
  // A local-spec (`file:`/`link:`) dev install must inline the heavy stack: its
  // unreleased version has no published `typeclaw-base` tag, and
  // resolveBaseImageVersion prefers node_modules/typeclaw/package.json#version —
  // which `ensureDeps` has already materialized by the time start() calls this —
  // so without the gate a release-shaped dev version pins a nonexistent
  // `FROM ghcr.io/...:<version>`. `null` selects the inline `oven/bun:1-slim`
  // path. Mirrors the same gate in writeDockerAssets (src/init/index.ts).
  const devMode = await hasLocallyLinkedTypeclawDep(cwd)
  const next = buildDockerfile(cfg.docker.file, {
    baseImageVersion: devMode ? null : resolveBaseImageVersion(cwd),
    cjkFontsAuto: hostLocaleIsCjk(),
    buildKit: opts.buildKit,
  })
  // Reuse the renderer's classifier so reported warnings match exactly what was
  // stripped/kept in the Dockerfile above (single source of truth).
  const { warnings } = classifyDockerfileAppend(cfg.docker.file.append)
  const path = join(cwd, DOCKERFILE)
  const prev = await readFile(path, 'utf8').catch(() => null)
  if (prev === next) return { changed: false, warnings }
  await writeFile(path, next)
  return { changed: true, warnings }
}

// Builds the agent image with a seamless buildx->legacy fallback. The preferred
// frontend is chosen from `hasBuildx`; if a buildx build FAILS (e.g. the plugin
// is installed but there is no usable builder/driver), we transparently rewrite
// the Dockerfile to its BuildKit-stripped form and retry once with the legacy
// `docker build`. The user sees one successful `typeclaw start` instead of a
// buildx-specific dead end. A genuine Dockerfile error fails both paths, so the
// retry costs at most one extra attempt before the real error surfaces.
//
// Layered on top is a credential-helper recovery: typeclaw only pulls PUBLIC
// images (the BuildKit syntax frontend + the typeclaw-base FROM), but a broken
// `credsStore`/`credHelpers` in ~/.docker/config.json makes docker abort the
// pull trying to exec a helper binary that isn't on PATH (the canonical Windows
// Docker Desktop failure). When a build fails with exactly that signature we
// retry the SAME build under a sanitized DOCKER_CONFIG that strips only the
// broken helper hooks — anonymous pulls then succeed and the user's real config
// is left untouched. This is checked BEFORE the buildx->legacy strip so a
// cred-helper failure doesn't get misdiagnosed as a buildx problem.
async function runImageBuild(args: {
  exec: DockerExec
  cwd: string
  imageTag: string
  buildContext: string
  hasBuildx: boolean
}): Promise<boolean> {
  const { exec, cwd, imageTag, buildContext, hasBuildx } = args
  const buildArgv = (frontend: 'buildx' | 'legacy'): string[] =>
    frontend === 'buildx'
      ? ['buildx', 'build', '--load', '-t', imageTag, buildContext]
      : ['build', '-t', imageTag, buildContext]

  let sanitizedConfig: SanitizedDockerConfig | null = null
  const attempt = async (frontend: 'buildx' | 'legacy'): Promise<DockerExecResult> =>
    exec(buildArgv(frontend), { cwd, inheritStdio: true, captureStderr: true, env: sanitizedConfig?.env })

  try {
    let frontend: 'buildx' | 'legacy' = hasBuildx ? 'buildx' : 'legacy'
    let result = await attempt(frontend)
    if (result.exitCode === 0) return true

    // Same-frontend retry: a broken credential helper aborts the pull before
    // the builder ever matters, so strip it and retry the identical build.
    if (sanitizedConfig === null && isMissingDockerCredentialHelper(result.stderr)) {
      sanitizedConfig = await createSanitizedDockerConfig()
      if (sanitizedConfig) {
        result = await attempt(frontend)
        if (result.exitCode === 0) return true
      }
    }

    if (frontend === 'buildx') {
      // buildx failed for a non-cred reason — fall back to the legacy builder
      // against a stripped Dockerfile so a misconfigured-buildx host still ends
      // up with an image. The sanitized config (if any) carries into the retry.
      await refreshDockerfile(cwd, { buildKit: false })
      frontend = 'legacy'
      result = await attempt(frontend)
      if (result.exitCode === 0) return true
      if (sanitizedConfig === null && isMissingDockerCredentialHelper(result.stderr)) {
        sanitizedConfig = await createSanitizedDockerConfig()
        if (sanitizedConfig) {
          result = await attempt(frontend)
          if (result.exitCode === 0) return true
        }
      }
    }

    if (sanitizedConfig !== null) {
      process.stderr.write(
        'typeclaw: docker build still failed after retrying public image pulls without the configured ' +
          'credential helper. Your ~/.docker/config.json credsStore/credHelpers may be broken.\n',
      )
    }
    return false
  } finally {
    await sanitizedConfig?.cleanup()
  }
}

type SanitizedDockerConfig = { env: { DOCKER_CONFIG: string }; cleanup: () => Promise<void> }

// Materializes a temp DOCKER_CONFIG dir that is a full DEEP COPY of the user's
// ~/.docker tree with only the broken credential-helper hooks stripped from the
// copied config.json. Returns null when there's nothing to strip (no creds
// hooks present), so the caller skips a pointless retry. Cleanup removes the dir
// on every build outcome.
//
// DOCKER_CONFIG is not just credentials: `contexts/` maps the current docker
// context (e.g. Docker Desktop's `desktop-linux`) to the daemon endpoint, and
// `buildx/` holds builder instance state. A relocated config missing those
// makes `docker buildx build` (and `docker build`, which Docker Desktop forwards
// to `buildx build --builder <currentContext>`) fail with `no builder
// "desktop-linux" found` — the exact second failure this replaces. The earlier
// approach symlinked those subdirs, but Windows `fs.symlink` throws EPERM
// without Developer Mode/admin, so the catch silently produced a config dir with
// the context/builder state ABSENT. A recursive copy is portable and preserves
// the full topology; only config.json is overwritten with the sanitized form.
async function createSanitizedDockerConfig(): Promise<SanitizedDockerConfig | null> {
  const srcDir = dockerConfigDir()
  const raw = await readFile(join(srcDir, 'config.json'), 'utf8').catch(() => null)
  const sanitized = sanitizeDockerConfigJson(raw)
  if (sanitized === null) return null

  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-dockercfg-'))
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true })
  try {
    if (existsSync(srcDir)) await cp(srcDir, dir, { recursive: true, dereference: false })
    await writeFile(join(dir, 'config.json'), sanitized)
  } catch {
    await cleanup()
    return null
  }
  return { env: { DOCKER_CONFIG: dir }, cleanup }
}

export async function refreshGitignore(cwd: string): Promise<void> {
  const cfg = await loadTypeclawConfig(cwd)
  await writeFile(join(cwd, GITIGNORE_FILE), buildGitignore(cfg.git.ignore))
}

// Re-exported from src/git/system-commit.ts so existing call sites
// (refreshGitignore wiring, doctor/commit.ts comment references, test
// imports) keep working under the original name. New code should import
// directly from @/git/system-commit instead. The sync sibling lives
// alongside in that module and is used by persistMigratedConfig to pair
// the migration write with a commit on every read path, not only here.
export const commitSystemFile = commitSystemFileShared

async function imageExists(exec: DockerExec, tag: string): Promise<boolean> {
  const result = await exec(['image', 'inspect', tag])
  return result.exitCode === 0
}

type InspectedState = { exists: false } | { exists: true; running: boolean }

async function inspectContainer(exec: DockerExec, name: string): Promise<InspectedState> {
  const result = await exec(['inspect', '--format', '{{.State.Running}}', name])
  if (result.exitCode !== 0) return { exists: false }
  return { exists: true, running: result.stdout.trim() === 'true' }
}

// Retries `docker run` on name-conflict responses by FIRST force-removing
// the non-running same-name corpse that's blocking the name. Sleep-only
// retries (PR #121's earlier approach) cannot recover when the corpse is
// stable — see isContainerNameConflict's comment for why corpses survive
// the preflight (port-bind-after-create leaves a created-but-not-running
// container record behind, and start()'s own port-TOCTOU retry triggers
// this path against that corpse).
//
// cleanupRunCorpse refuses to touch a running container, so a concurrent
// legitimate start of the same name (or a foreign-but-named container the
// user wants alive) is surfaced as a hard failure rather than silently
// killed. 'stuck' likewise surfaces — a wedged daemon that won't drain a
// removal needs the user to act (`docker rm -f <name>` manually, or restart
// Docker) instead of looping forever.
//
// A bounded backoff (100/200/400/800/1200ms) follows each cleanup before the
// next `docker run`. waitForRemoval polls `docker inspect`, which can
// report the container gone BEFORE Docker's internal name-reservation
// table has fully released the name. Without the backoff, the retries can
// all fire inside the same daemon drain window and exhaust uselessly. The
// cumulative ~2.7s is small next to the docker run RTT itself and dwarfed by
// the user-visible cost of a failed start.
//
// Only the name-conflict path engages this destructive retry. Any other
// non-zero exit (port-allocated, image-not-found, permission-denied) is
// returned unchanged so the existing port-conflict TOCTOU retry and
// surfacing keep working without being shadowed.
async function execRunWithConflictRetry(
  exec: DockerExec,
  runArgs: string[],
  cwd: string,
  containerName: string,
): Promise<DockerExecResult> {
  let last = await exec(runArgs, { cwd })
  for (const backoffMs of CONFLICT_RETRY_BACKOFFS_MS) {
    if (last.exitCode === 0) return last
    if (!isContainerNameConflict(last.stderr)) return last
    const outcome = await cleanupRunCorpse(exec, containerName)
    if (outcome === 'running' || outcome === 'stuck') return last
    await new Promise((resolve) => setTimeout(resolve, backoffMs))
    last = await exec(runArgs, { cwd })
  }
  return last
}

const CONFLICT_RETRY_BACKOFFS_MS = [100, 200, 400, 800, 1200] as const

// Idempotent path for `start()`: the named container is already up. Reflect
// the live container's identity (id) and host port in the result so callers
// (CLI, compose) can render an accurate "already running on port X" message
// and stay symmetric with the fresh-launch result shape. We do NOT touch
// hostd here — the existing container was registered (or not) at its original
// launch; re-registering would generate a new restart token that the running
// agent process does not have.
async function reportAlreadyRunning(exec: DockerExec, cwd: string, containerName: string): Promise<StartResult> {
  const containerId = await queryContainerId(exec, containerName)
  const hostPort = await queryPublishedHostPort(exec, containerName)
  if (hostPort === null) {
    return {
      ok: false,
      reason: `Container ${containerName} is running but its published host port could not be resolved.`,
    }
  }
  const tuiToken = await resolveTuiToken({ cwd, exec })
  const plan = await planStart({ cwd, hostPort, imageExists: true, forceBuild: false, tuiToken })
  const { warnings: dockerfileWarnings } = classifyDockerfileAppend((await loadTypeclawConfig(cwd)).docker.file.append)
  return {
    ok: true,
    plan,
    containerId,
    built: false,
    hostPort,
    tuiToken,
    hostd: { state: 'disabled' },
    alreadyRunning: true,
    autoUpgrade: { kind: 'skipped-already-running' },
    skippedPlugins: [],
    dockerfileWarnings,
  }
}

async function queryContainerId(exec: DockerExec, name: string): Promise<string> {
  const result = await exec(['inspect', '--format', '{{.Id}}', name])
  if (result.exitCode !== 0) return ''
  return result.stdout.trim()
}

// Mirrors `resolveHostPort` from ./port (which we cannot reuse directly because
// it goes through `defaultDockerExec` and would defeat the test seam).
async function queryPublishedHostPort(exec: DockerExec, name: string): Promise<number | null> {
  const result = await exec(['port', name, `${CONTAINER_PORT}/tcp`])
  if (result.exitCode !== 0) return null
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null
  const ipv4 = lines.find((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
  const candidate = ipv4 ?? lines[0]!
  const lastColon = candidate.lastIndexOf(':')
  if (lastColon < 0) return null
  const port = Number(candidate.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

// Mirror the canonical labels `docker compose up` sets so Docker Desktop groups
// all typeclaw agents under a single "typeclaw" project, and `docker compose ls`
// recognizes the project. Each agent shows up as a service named after its folder.
function composeLabels(cwd: string, service: string): Record<string, string> {
  return {
    'com.docker.compose.project': COMPOSE_PROJECT,
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': cwd,
    'com.docker.compose.container-number': '1',
    'com.docker.compose.oneoff': 'False',
    'com.docker.compose.config-hash': 'manual',
  }
}

async function detectDevSource(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, PACKAGE_FILE), 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = pkg.dependencies?.typeclaw
    if (typeof spec !== 'string') return null
    // Windows dev-mode declares `link:typeclaw` (a `bun link` registration);
    // the checkout path isn't in the spec, so resolve it from bun's global
    // link target. POSIX dev-mode declares `file:<rel>` and encodes the path.
    if (spec.startsWith('link:')) return resolveBunLinkedPackage(TYPECLAW_PACKAGE)
    if (!spec.startsWith('file:')) return null
    const target = spec.slice('file:'.length)
    return isAbsolute(target) ? resolve(target) : resolve(cwd, target)
  } catch {
    return null
  }
}

// True when `child` is `parent` itself or nested beneath it. Lexical, not
// realpath-aware — callers pass already-resolved absolute paths. Preferred over
// `child.startsWith(parent)`, which mis-fires on sibling-prefix collisions
// (`C:\foo` vs `C:\foobar`), trailing-separator skew, and would treat
// `/srv/agentX` as inside `/srv/agent`. A dev source already inside the agent
// folder is reachable through the `/agent` bind mount, so neither dev-source
// branch should add a second mount for it.
export function isPathInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// POSIX dev mode: node_modules/typeclaw is a symlink to an absolute host path
// outside /agent. The mirror mount bind-mounts that path at the SAME path inside
// the (Linux) container so the symlink resolves. That only works when the host
// path is itself a valid Linux container path — true on POSIX, false on native
// Windows where devSourcePath is `C:\...` (not an absolute Linux path, so it
// cannot be a same-path container mount `dst`). Native Windows takes the
// `shouldMountWindowsDevSource` branch instead (mount the checkout directly over
// the in-container node_modules path). End users install typeclaw from npm (a
// registry spec, not file:), so they never hit either dev path.
export function shouldMirrorDevSource(
  devSourcePath: string | null,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): devSourcePath is string {
  return devSourcePath !== null && !isPathInsideOrEqual(devSourcePath, cwd) && !isWindows(platform)
}

// Native-Windows dev mode (#899): the host's `C:\...` checkout cannot be
// same-path mirror-mounted into a Linux container. Instead, bind-mount the
// checkout directly over the standard resolution path `/agent/node_modules/
// typeclaw` inside the container, so Node/Bun resolve typeclaw from source
// regardless of how the host materialized node_modules/typeclaw (a junction,
// per prepareWindowsDevJunction). Like the POSIX branch, skip when the dev
// source lives inside the agent folder: a `file:./vendor/typeclaw` checkout is
// already exposed via the `/agent` mount, so a second mount is wrong. A
// bun-linked (`link:`) checkout legitimately lives outside cwd and still mounts.
export function shouldMountWindowsDevSource(
  devSourcePath: string | null,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): devSourcePath is string {
  return devSourcePath !== null && !isPathInsideOrEqual(devSourcePath, cwd) && isWindows(platform)
}

// True when the agent's package.json declares typeclaw via `file:` or
// `link:` — i.e. a developer is iterating on the typeclaw source via a
// locally-linked checkout. `bun install` keys its file-dep cache on
// name+version, so it treats a stale cached copy as a cache hit even
// after the source on disk has changed. `typeclaw start --build` uses
// this gate to force `bun install --force` only in dev: registry-spec
// users (`^X.Y.Z`, `~X.Y.Z`, exact pins) pay nothing because their
// install path is already cache-correct.
async function hasLocallyLinkedTypeclawDep(cwd: string): Promise<boolean> {
  const spec = await readTypeclawDepSpec(cwd)
  return spec !== null && (spec.startsWith('file:') || spec.startsWith('link:'))
}

async function readTypeclawDepSpec(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, PACKAGE_FILE), 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = pkg.dependencies?.typeclaw
    return typeof spec === 'string' ? spec : null
  } catch {
    return null
  }
}

// A missing typeclaw.json is tolerated (e.g. test fixtures, freshly-cloned
// folder mid-init). Anything else — malformed JSON, schema-invalid config,
// invalid mount entry — must surface so the user sees they configured a mount
// that won't be applied.
async function loadTypeclawConfig(cwd: string): Promise<Config> {
  // Goes through the shared loadConfigSync so the legacy-shape migration
  // (and its paired git commit via persistMigratedConfig) follows every
  // start() read path — refreshGitignore, the docker run argv builder, and
  // the daemon-register payload all eventually land here. The function is
  // declared async only to preserve the existing await sites; the work is
  // synchronous under the hood.
  return loadConfigSync(cwd)
}

async function registerWithDaemon({
  cwd,
  containerName,
  cliEntry,
  hostPort,
  reuseCurrentHostDaemon,
  currentHostDaemon,
}: {
  cwd: string
  containerName: string
  cliEntry: string
  hostPort: number
  reuseCurrentHostDaemon: boolean
  currentHostDaemon: CurrentHostDaemon | undefined
}): Promise<PreparedHostDaemonStatus> {
  const token = randomBytes(32).toString('base64url')
  const brokerToken = randomBytes(32).toString('base64url')
  const cfg = await loadTypeclawConfig(cwd)
  const payload: HostDaemonRegisterPayload = {
    containerName,
    cwd,
    restartToken: token,
    wsHostPort: hostPort,
    portForward: cfg.portForward,
    brokerToken,
  }

  if (currentHostDaemon) {
    // A thrown/rejected registrar must degrade to a still-booting container,
    // not abort start() — the daemon-owned restart already stopped the old
    // container, so ok:false here would leave the agent dead.
    let reply: { ok: true } | { ok: false; reason: string }
    try {
      reply = await currentHostDaemon.register(payload)
    } catch (error) {
      return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    if (!reply.ok) return { state: 'unavailable', reason: reply.reason }
    return {
      state: 'registered',
      control: { url: `http://${CONTAINER_HOSTD_HOST}:${currentHostDaemon.httpPort}`, token, brokerToken },
    }
  }

  const prepared = reuseCurrentHostDaemon ? await useCurrentHostDaemon() : await ensureDaemonWithBridgeRetry(cliEntry)
  if (!prepared.ok) return { state: 'unavailable', reason: prepared.reason }
  const reply = await sendToDaemon({ kind: 'register', ...payload })
  if (!reply.ok) return { state: 'unavailable', reason: reply.reason }
  return {
    state: 'registered',
    control: { url: `http://${CONTAINER_HOSTD_HOST}:${prepared.httpPort}`, token, brokerToken },
  }
}

// ensureDaemon spawns the daemon detached and polls for readiness, but a cold
// daemon can take longer than that internal window to bind its socket. Rather
// than treat the first not-ready-yet as a hard failure (which would drop the
// hostd env vars and crash hostd-backed channel adapters on boot), re-probe a
// few times: the still-booting daemon becomes reachable and ensureDaemon
// fast-paths through its top-of-function isDaemonReachable() check WITHOUT
// re-spawning. Bridges the first-boot spawn race; a genuinely dead daemon still
// surfaces as unavailable after the budget.
const HOSTD_BRIDGE_RETRIES = 3
const HOSTD_BRIDGE_RETRY_DELAY_MS = 2_000

async function ensureDaemonWithBridgeRetry(cliEntry: string): Promise<EnsureDaemonResult> {
  let last = await ensureDaemon({ cliEntry })
  for (let attempt = 0; !last.ok && attempt < HOSTD_BRIDGE_RETRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, HOSTD_BRIDGE_RETRY_DELAY_MS))
    last = await ensureDaemon({ cliEntry })
  }
  return last
}

async function useCurrentHostDaemon(): Promise<{ ok: true; httpPort: number } | { ok: false; reason: string }> {
  const reply = await sendToDaemon({ kind: 'http-info' })
  if (!reply.ok) return { ok: false, reason: reply.reason }
  const result = reply.result as HttpInfoResult | undefined
  if (typeof result?.port !== 'number' || result.port <= 0 || result.port > 65_535) {
    return { ok: false, reason: 'daemon did not report an HTTP control port' }
  }
  return { ok: true, httpPort: result.port }
}

type PreparedHostDaemonStatus =
  | { state: 'registered'; control: HostDaemonControl }
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

function stripHostDaemonControl(status: PreparedHostDaemonStatus): HostDaemonStatus {
  if (status.state === 'registered') return { state: 'registered' }
  return status
}

async function cleanupHostDaemonRegistration(containerName: string, status: PreparedHostDaemonStatus): Promise<void> {
  if (status.state !== 'registered') return
  await sendToDaemon({ kind: 'deregister', containerName }).catch(() => {})
}

// process.env.TZ is honored first because users who explicitly set it (e.g.
// `TZ=UTC typeclaw start` for testing) expect that to win over their system
// default. Falls back to Intl, which works reliably on macOS where TZ is
// usually unset. Returns null if neither yields an IANA zone name.
function resolveHostTimezone(): string | null {
  const explicit = process.env.TZ
  if (explicit && explicit.length > 0) return explicit
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
    return detected && detected.length > 0 ? detected : null
  } catch {
    return null
  }
}
