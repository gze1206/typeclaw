import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from '@/sandbox/canonical-secrets'

import { hooklessGitArgs } from './hookless'
import { resolveAgentGit } from './resolve-agent-git'

type ScanResult = { ok: true } | { ok: false; paths: string[] }

const contaminatedCache = new Map<string, string[]>()

export class GitSecretHistoryError extends Error {
  constructor(paths: readonly string[]) {
    super(
      [
        `Model-driven Git/bash is disabled because Git metadata is contaminated or can conceal objects: ${paths.join(', ')}.`,
        'Assume credentials in the repository were exposed and rotate them first. Purge canonical secret paths and every refs/replace entry, expire all reflogs, and run Git garbage collection to remove unreachable objects before retrying.',
        'Suggested operator sequence: rewrite/purge the affected history and replacement refs, run `git reflog expire --expire=now --all`, then `git gc --prune=now`, and restart TypeClaw before retrying.',
        'TypeClaw inspects path names and object reachability without reading blob contents. Reachable, reflog-referenced, and unreachable commits are path-attributable via their root tree and block only when a canonical secret path is present; standalone dangling trees and blobs are not path-attributable and are ignored; a live ref, worktree HEAD, or pseudoref (including FETCH_HEAD) pointing at a non-commit still fails closed.',
      ].join(' '),
    )
    this.name = 'GitSecretHistoryError'
  }
}

export async function assertNoCanonicalSecretsInGit(agentDir: string): Promise<void> {
  const contaminated = contaminatedCache.get(agentDir)
  if (contaminated !== undefined) throw new GitSecretHistoryError(contaminated)

  const scan = await scanCanonicalSecretsInGit(agentDir)
  if (!scan.ok) {
    contaminatedCache.set(agentDir, scan.paths)
    throw new GitSecretHistoryError(scan.paths)
  }
}

export async function scanCanonicalSecretsInGit(agentDir: string): Promise<ScanResult> {
  const layout = resolveAgentGit(agentDir)
  if (layout === null) return { ok: true }
  const gitArgs = layout.gitArgs
  const inside = await runGit(agentDir, gitArgs, ['rev-parse', '--is-inside-work-tree'])
  if (inside.trim() !== 'true') throw new GitSecretHistoryError(['Git metadata did not resolve to a work tree'])

  const replacements = await runGit(agentDir, gitArgs, ['for-each-ref', '--format=%(refname)', 'refs/replace'])
  if (replacements.trim() !== '') return { ok: false, paths: ['replacement refs exist under refs/replace'] }

  const nonCommitRoots = await scanNonCommitRefRoots(agentDir, gitArgs)
  if (!nonCommitRoots.ok) return nonCommitRoots

  const index = await runGit(agentDir, gitArgs, ['ls-files', '--cached', '-z'])
  const reachablePaths = matchingCanonicalPaths(splitNul(index))

  const objects = await runGit(agentDir, gitArgs, ['rev-list', '--objects', '--all', '--reflog'])
  for (const line of objects.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator >= 0) reachablePaths.push(...matchingCanonicalPaths([decodeGitPath(line.slice(separator + 1))]))
  }

  const unreachableMatches = await scanUnreachableObjects(agentDir, gitArgs)
  if (!unreachableMatches.ok) return unreachableMatches

  const matches = [...new Set([...reachablePaths, ...unreachableMatches.paths])].sort()
  if (matches.length > 0) return { ok: false, paths: matches }

  return { ok: true }
}

type UnreachableScan = { ok: false; paths: string[] } | { ok: true; paths: string[] }

// FETCH_HEAD and MERGE_HEAD are the two root refs `for-each-ref --include-root-refs` deliberately
// omits (Git classifies them as pseudorefs). They are filesystem-only and multi-line (one oid per
// line), so they are always read from their files directly rather than enumerated.
const GIT_MULTILINE_PSEUDOREFS = ['FETCH_HEAD', 'MERGE_HEAD'] as const

// Single-oid root-ref fallback for Git < 2.45, which lacks `for-each-ref --include-root-refs`. Not
// exhaustive by design — any all-caps `*_HEAD`-style root ref (e.g. a custom one) is caught by the
// flag on modern Git; this list only backstops the ones Git itself commonly writes on old versions.
const GIT_FALLBACK_ROOT_REFS = [
  'HEAD',
  'ORIG_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_HEAD',
  'AUTO_MERGE',
] as const

// A ref, worktree HEAD, or root ref/pseudoref pointing at (or a tag peeling to) a non-commit makes
// that tree/blob live, so neither fsck mode reports it and rev-list cannot root-anchor its path.
// Such a live root has no repository path prefix, so it fails closed exactly like an orphan tree.
// Ordinary commit-ish roots are handled by the reachable/reflog path scans.
async function scanNonCommitRefRoots(agentDir: string, gitArgs: readonly string[]): Promise<UnreachableScan> {
  const listing = await runGit(agentDir, gitArgs, ['worktree', 'list', '--porcelain'])
  const headRefs: string[] = []
  const linkedWorktrees: string[] = []
  for (const line of listing.split('\n')) {
    if (line.startsWith('HEAD ')) headRefs.push(line.slice('HEAD '.length).trim())
    else if (line.startsWith('worktree ')) {
      const path = line.slice('worktree '.length).trim()
      if (path !== '' && path !== agentDir) linkedWorktrees.push(path)
    }
  }
  const refs = await runGit(agentDir, gitArgs, ['for-each-ref', '--format=%(objectname)'])
  const rootRefOids = await collectRootRefOids(agentDir, gitArgs, linkedWorktrees)
  const roots = [...new Set([...headRefs, ...refs.split('\n'), ...rootRefOids].map((oid) => oid.trim()))].filter(
    (oid) => oid !== '' && !/^0+$/.test(oid),
  )

  for (const root of roots) {
    // A pruning `git gc` deletes the object a reset/rebase left in a pseudoref (ORIG_HEAD, etc.) but
    // never rewrites the ref, so it dangles at an oid that is now absent from the object DB. A gone
    // object cannot conceal a secret, so skip it rather than failing the whole scan closed on the
    // peel error. Only a root whose object still EXISTS and is a non-commit remains blocking.
    if (!(await objectExists(agentDir, gitArgs, root))) continue
    const target = await peelTag(agentDir, gitArgs, root)
    if (target.type !== 'commit') return { ok: false, paths: ['unattributable dangling Git objects'] }
  }
  return { ok: true, paths: [] }
}

// Collects every oid pinned by a top-level root ref across the main worktree AND every linked one
// (each linked worktree owns its own root-ref files under `$GIT_COMMON_DIR/worktrees/<id>/`, so a
// non-commit pinned only there must be probed too). The main worktree keeps the caller's gitArgs so
// the .gitstore --git-dir/--work-tree layout still resolves (that layout reports no linked
// worktrees); linked worktrees are discovered from their own path.
//
// Enumeration is exhaustive rather than a fixed allowlist: `for-each-ref --include-root-refs` lists
// ALL root refs Git recognizes — including arbitrary `*_HEAD`-style ones like CUSTOM_HEAD — so no
// unlisted root ref can slip a non-commit past the guard. On Git < 2.45 (no flag) we fall back to
// probing the common single-oid root refs by name. FETCH_HEAD/MERGE_HEAD are always read from their
// files (multi-line; the flag omits them) via `rev-parse --git-path`. Absent refs are skipped.
async function collectRootRefOids(
  agentDir: string,
  gitArgs: readonly string[],
  linkedWorktrees: readonly string[],
): Promise<string[]> {
  const probes: { cwd: string; args: readonly string[] }[] = [
    { cwd: agentDir, args: gitArgs },
    ...linkedWorktrees.map((path) => ({ cwd: path, args: [] as readonly string[] })),
  ]
  const oids: string[] = []
  for (const probe of probes) {
    const rootRefs = await tryGit(probe.cwd, probe.args, [
      'for-each-ref',
      '--include-root-refs',
      '--format=%(objectname)',
    ])
    if (rootRefs.ok) {
      for (const line of rootRefs.stdout.split('\n')) oids.push(line.trim())
    } else {
      for (const name of GIT_FALLBACK_ROOT_REFS) {
        const resolved = await tryGit(probe.cwd, probe.args, ['rev-parse', '--verify', '--quiet', name])
        if (resolved.ok) oids.push(resolved.stdout.trim())
      }
    }
    for (const name of GIT_MULTILINE_PSEUDOREFS) {
      const path = (await runGit(probe.cwd, probe.args, ['rev-parse', '--git-path', name])).trim()
      if (path === '') continue
      const file = Bun.file(isAbsolute(path) ? path : join(probe.cwd, path))
      if (!(await file.exists())) continue
      for (const line of (await file.text()).split('\n')) {
        const oid = line.split(/[\s\t]/, 1)[0]?.trim()
        if (oid !== undefined && /^[0-9a-f]{40,64}$/.test(oid)) oids.push(oid)
      }
    }
  }
  return oids
}

// Only an unreachable commit is safely attributable: it records a repository root tree, so we walk
// it (and tags peeling to a commit) and report the actual canonical secret paths it carries.
//
// Standalone unreachable trees/blobs (and tags peeling only to them) are deliberately NOT blocked.
// A bare blob never stored its filename and an orphan tree lost the parent that carried its prefix,
// so their names cannot prove they sat under a canonical secret dir. Failing closed on them bricked
// all model-driven bash on benign debris that TypeClaw's own backup rebase and history rewrites
// leave behind and never garbage-collect. Accepted residual: a secret surviving ONLY as pathless
// objects (e.g. `git add -f secrets.json` then `git reset`, which leaves no reflog entry, or a
// committed secret whose every path-bearing commit has since vanished). While any path-bearing
// commit survives — reachable, reflog, or unreachable — the caller's `rev-list --all --reflog` scan
// and this unreachable-commit walk still report the path; `--no-reflogs` keeps this a superset that
// routes benign reflog-reachable commits through commit attribution instead of double-reporting.
async function scanUnreachableObjects(agentDir: string, gitArgs: readonly string[]): Promise<UnreachableScan> {
  const fsck = await runGit(agentDir, gitArgs, ['fsck', '--unreachable', '--no-reflogs', '--no-progress'])
  const unreachable = parseUnreachableObjects(fsck)
  if (unreachable.length === 0) return { ok: true, paths: [] }

  const commits = new Set<string>()
  for (const object of unreachable) {
    if (object.type === 'commit') commits.add(object.oid)
    else if (object.type === 'tag') {
      const target = await peelTag(agentDir, gitArgs, object.oid)
      if (target.type === 'commit') commits.add(target.oid)
    }
  }

  const attributed = new Set<string>()
  const matches: string[] = []
  for (const commit of commits) {
    const rootTree = (await runGit(agentDir, gitArgs, ['rev-parse', `${commit}^{tree}`])).trim()
    const entries = await runGit(agentDir, gitArgs, ['ls-tree', '-r', '-t', '-z', '--full-tree', rootTree])
    attributed.add(rootTree)
    matches.push(...collectTreeEntries(entries, attributed))
  }

  return matches.length > 0 ? { ok: false, paths: [...new Set(matches)].sort() } : { ok: true, paths: [] }
}

// `cat-file -e` exits 0 when the object is present and exactly 1 when it is absent. Any other exit
// code is an operational Git error (corruption, bad invocation), which must fail closed like every
// other scan step rather than being misread as a benign "object gone".
async function objectExists(agentDir: string, gitArgs: readonly string[], oid: string): Promise<boolean> {
  const { exitCode, stderr } = await spawnGit(agentDir, gitArgs, ['cat-file', '-e', oid])
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  throw new GitSecretHistoryError([`Git metadata scan failed (cat-file): ${redactGitError(stderr)}`])
}

type PeeledTag = { type: 'commit' | 'tree' | 'blob' | 'unknown'; oid: string }

// `<tag>^{}` recursively peels tag-of-tag chains to the final non-tag object. A malformed or cyclic
// tag makes rev-parse/cat-file exit non-zero, which throws in runGit and fails the whole scan closed.
async function peelTag(agentDir: string, gitArgs: readonly string[], tag: string): Promise<PeeledTag> {
  const oid = (await runGit(agentDir, gitArgs, ['rev-parse', `${tag}^{}`])).trim()
  const type = (await runGit(agentDir, gitArgs, ['cat-file', '-t', oid])).trim()
  if (type === 'commit' || type === 'tree' || type === 'blob') return { type, oid }
  return { type: 'unknown', oid }
}

type UnreachableObject = { type: 'commit' | 'tree' | 'blob' | 'tag'; oid: string }

function parseUnreachableObjects(fsck: string): UnreachableObject[] {
  const objects: UnreachableObject[] = []
  for (const line of fsck.split('\n')) {
    const match = /^unreachable (commit|tree|blob|tag) ([0-9a-f]{40,64})$/.exec(line.trim())
    if (match) objects.push({ type: match[1] as UnreachableObject['type'], oid: match[2] as string })
  }
  return objects
}

function collectTreeEntries(nulSeparated: string, attributed: Set<string>): string[] {
  const matches: string[] = []
  for (const entry of splitNul(nulSeparated)) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const meta = entry.slice(0, tab).split(/\s+/)
    const oid = meta[2]
    const path = decodeGitPath(entry.slice(tab + 1))
    if (oid !== undefined) attributed.add(oid)
    if (matchesKnownRootPath(path)) matches.push(path)
  }
  return matches
}

function decodeGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escaped = raw.slice(1, -1)
  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index] as string
    if (character !== '\\') {
      bytes.push(...encoder.encode(character))
      continue
    }
    const next = escaped[++index]
    if (next === undefined) return raw
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    }
    const simpleByte = simple[next]
    if (simpleByte !== undefined) {
      bytes.push(simpleByte)
      continue
    }
    if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && index + 1 < escaped.length && /[0-7]/.test(escaped[index + 1] as string)) {
        octal += escaped[++index]
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(...encoder.encode(next))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

export function resetGitSecretHistoryCacheForTests(): void {
  contaminatedCache.clear()
}

function matchingCanonicalPaths(paths: readonly string[]): string[] {
  return paths.filter((raw) => matchesKnownRootPath(normalizeGitPath(raw)))
}

function normalizeGitPath(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^\.\//, '')
}

function matchesKnownRootPath(raw: string): boolean {
  const path = normalizeGitPath(raw)
  if (CANONICAL_AGENT_SECRET_FILES.some((secret) => path === secret)) return true
  return CANONICAL_AGENT_SECRET_DIRS.some((dir) => path.startsWith(`${dir}/`))
}

function splitNul(value: string): string[] {
  return value.split('\0').filter((entry) => entry !== '')
}

async function spawnGit(
  agentDir: string,
  gitArgs: readonly string[],
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['git', ...hooklessGitArgs(['-C', agentDir, ...gitArgs, ...args])], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: await buildGitScanEnv(agentDir),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export async function buildGitScanEnv(agentDir: string): Promise<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: await realpath(agentDir),
    GIT_NO_REPLACE_OBJECTS: '1',
    // Keep the scan strictly local. GIT_NO_LAZY_FETCH stops a promisor/partial-clone fetch on
    // Git >=2.45 (and backported maints), but is silently ignored on older Git; the empty
    // GIT_ALLOW_PROTOCOL whitelist (a since-2.20 control) denies every transport, so even the
    // internal lazy `git fetch` those versions still attempt fails closed before touching a remote.
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
  }
}

async function runGit(agentDir: string, gitArgs: readonly string[], args: readonly string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await spawnGit(agentDir, gitArgs, args)
  if (exitCode === 0) return stdout
  throw new GitSecretHistoryError([`Git metadata scan failed (${args[0] ?? 'unknown'}): ${redactGitError(stderr)}`])
}

// Non-throwing variant for probes whose failure is a valid signal (an absent root ref, or an
// `--include-root-refs` flag unsupported on old Git) rather than a contamination error.
async function tryGit(
  agentDir: string,
  gitArgs: readonly string[],
  args: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  const { stdout, exitCode } = await spawnGit(agentDir, gitArgs, args)
  return exitCode === 0 ? { ok: true, stdout } : { ok: false }
}

function redactGitError(stderr: string): string {
  const firstLine = stderr.split(/\r?\n/, 1)[0]?.trim()
  return firstLine === undefined || firstLine === '' ? 'unknown Git error' : firstLine.slice(0, 200)
}
