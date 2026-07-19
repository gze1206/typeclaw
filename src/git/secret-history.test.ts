import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { isWindows } from '@/shared'

import {
  GitSecretHistoryError,
  assertNoCanonicalSecretsInGit,
  buildGitScanEnv,
  resetGitSecretHistoryCacheForTests,
  scanCanonicalSecretsInGit,
} from './secret-history'

let roots: string[] = []

beforeEach(() => resetGitSecretHistoryCacheForTests())
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('canonical Git secret history guard', () => {
  test('builds scanner-only configuration that accepts a dubious-owned agent directory', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const env = await buildGitScanEnv(repo)
    const proc = Bun.spawn(['git', '-C', repo, 'rev-parse', '--is-inside-work-tree'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
    })
    expect(await new Response(proc.stdout).text()).toBe('true\n')
    expect(await proc.exited).toBe(0)
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory')
    expect(env.GIT_CONFIG_VALUE_0).toBe(await realpath(repo))
  })

  test('leaves a clean repository unaffected', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('detects canonical files in the current index without reading their contents', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'secrets.json'), '{"token":"example-placeholder"}')
    await git(repo, 'add', 'secrets.json')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: false, paths: ['secrets.json'] })
  })

  test('allows an unattributable blob left by staging and resetting a canonical secret', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()

    // Accepted residual: `git add -f` + `git reset` leaves a pathless unreachable blob with no
    // reflog entry, so no surviving object records its canonical path. See scanUnreachableObjects.
    await writeFile(join(repo, 'secrets.json'), '{"credential":"placeholder"}')
    await git(repo, 'add', 'secrets.json')
    await git(repo, 'reset', '--', 'secrets.json')
    await rm(join(repo, 'secrets.json'))

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('rejects replacement refs even when a replacement commit hides a canonical secret path', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const cleanCommit = await gitOutput(repo, 'rev-parse', 'HEAD')
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    const secretCommit = await gitOutput(repo, 'rev-parse', 'HEAD')
    await git(repo, 'replace', secretCommit, cleanCommit)

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/replacement ref|rotate.*purge/i)
  })

  test('detects a canonical secret in an unreachable commit alongside unrelated orphan debris', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')
    await gitStdin(repo, 'unrelated orphan bytes', 'hash-object', '-w', '--stdin')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('detects a removed canonical file that remains reachable from history', async () => {
    const repo = await makeRepo()
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    await rm(join(repo, '.env'))
    await git(repo, 'add', '.env')
    await git(repo, 'commit', '-m', 'remove example credential')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(GitSecretHistoryError)
  })

  test('decodes Git C-quoted historical paths before canonical matching', async () => {
    const repo = await makeRepo()
    const unusual = 'workspace/.agent-messenger/비밀.json'
    await commitFile(repo, unusual, '{"credential":"placeholder"}')
    await rm(join(repo, unusual))
    await git(repo, 'add', unusual)
    await git(repo, 'commit', '-m', 'remove unusual credential path')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/workspace\/\.agent-messenger/i)
  })

  test('detects a canonical credential commit left unreachable by a hard reset by its path', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('detects a canonical credential in an unreachable commit after its reflog is expired', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows benign unreachable commits left by an amend', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await writeFile(join(repo, 'README.md'), 'safer')
    await git(repo, 'add', 'README.md')
    await git(repo, 'commit', '--amend', '-m', 'safe amended')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows benign unreachable commits and reflog remnants left by a hard reset', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows an orphan tree whose only entry is an innocuous name', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    await gitStdin(repo, `100644 blob ${blob}\trandom-session-id\n`, 'mktree')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: true })
  })

  test('allows an orphan tree even when it carries a canonical secret filename', async () => {
    // Accepted residual: an orphan tree lost its parent prefix, so its own entry names cannot prove
    // whether it sat under a canonical secret directory; benign history-rewrite debris looks the same.
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    await gitStdin(repo, `100644 blob ${blob}\tsecrets.json\n`, 'mktree')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: true })
  })

  test('allows a bare dangling blob', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await gitStdin(repo, 'bare secret bytes with no referencing tree', 'hash-object', '-w', '--stdin')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: true })
  })

  test('attributes a canonical secret through an unreachable tag that peels to a commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'tag', '-a', 'snapshot', '-m', 'snapshot')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'tag', '-d', 'snapshot')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows an unreachable tag that peels to a benign commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'tag', '-a', 'snapshot', '-m', 'snapshot')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'tag', '-d', 'snapshot')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows an unreachable tag that peels only to a tree', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, 'notes', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')
    await git(repo, 'tag', '-a', 'treetag', '-m', 'tree tag', tree)
    await git(repo, 'tag', '-d', 'treetag')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: true })
  })

  test('allows a canonical blob that only a reflog retains', async () => {
    // Accepted residual: the blob is unreachable except through a reflog entry and has no surviving
    // path-bearing commit, so no attributable object records its canonical path.
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await writeFile(join(repo, '.env'), 'EXAMPLE_TOKEN=placeholder')
    await git(repo, 'add', '.env')
    const blob = await gitOutput(repo, 'rev-parse', ':.env')
    await git(repo, 'reset', '--', '.env')
    await rm(join(repo, '.env'))
    await git(repo, 'update-ref', '--create-reflog', 'refs/test/reflog-root', blob)
    await git(repo, 'update-ref', 'refs/test/reflog-root', 'HEAD')

    const bare = await gitOutput(repo, 'fsck', '--unreachable', '--no-reflogs', '--no-progress')
    expect(bare).toContain(`unreachable blob ${blob}`)

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: true })
  })

  test('detects a canonical path in an unexpired reflog-only commit via the reflog scan', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')

    const honored = await gitOutput(repo, 'fsck', '--unreachable', '--no-progress')
    expect(honored.trim()).toBe('')
    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows a benign reflog-only commit left by a reset', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'reset', '--hard', 'HEAD^')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('rejects live refs that point at or peel to a non-commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')

    for (const [ref, oid] of [
      ['refs/test/blob', blob],
      ['refs/test/tree', tree],
    ] as const) {
      await git(repo, 'update-ref', ref, oid)
      expect(await scanCanonicalSecretsInGit(repo)).toEqual({
        ok: false,
        paths: ['unattributable dangling Git objects'],
      })
      await git(repo, 'update-ref', '-d', ref)
    }

    await git(repo, 'tag', '-a', 'blobtag', '-m', 'x', blob)
    expect(await scanCanonicalSecretsInGit(repo)).toEqual({
      ok: false,
      paths: ['unattributable dangling Git objects'],
    })
    await git(repo, 'tag', '-d', 'blobtag')
  })

  test('rejects a FETCH_HEAD pseudoref whose tag peels to a tree', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, 'notes', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')
    const tag = await gitStdin(
      repo,
      `object ${tree}\ntype tree\ntag treetag\ntagger t <test@example.com> 0 +0000\n\nx\n`,
      'hash-object',
      '-w',
      '-t',
      'tag',
      '--stdin',
    )
    // for-each-ref never enumerates FETCH_HEAD, and the tag/tree is reachable-or-ignored otherwise,
    // so the pseudoref probe is the only thing that can catch this.
    const fetchHeadPath = await gitOutput(repo, 'rev-parse', '--git-path', 'FETCH_HEAD')
    await writeFile(join(repo, fetchHeadPath), `${tag}\t\tbranch x of somewhere\n`)

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({
      ok: false,
      paths: ['unattributable dangling Git objects'],
    })
  })

  test('allows a FETCH_HEAD pseudoref whose tag peels to a commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const head = await gitOutput(repo, 'rev-parse', 'HEAD')
    const fetchHeadPath = await gitOutput(repo, 'rev-parse', '--git-path', 'FETCH_HEAD')
    await writeFile(join(repo, fetchHeadPath), `${head}\t\tbranch x of somewhere\n`)

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows an ORIG_HEAD left dangling by garbage collection', async () => {
    // Real-world regression: `git gc --prune=now` deletes the object a reset/rebase left in
    // ORIG_HEAD but never rewrites the pseudoref, so ORIG_HEAD points at an object that is now
    // absent from the object DB. peeling it (`rev-parse <gone>^{}`) exits non-zero — the object
    // is gone, so it cannot conceal a secret and must not fail the whole scan closed.
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'reset', '--hard', 'HEAD^')
    const origHead = await gitOutput(repo, 'rev-parse', 'ORIG_HEAD')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')
    await git(repo, 'gc', '--prune=now')

    await expect(gitOutput(repo, 'cat-file', '-t', origHead)).rejects.toThrow()
    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows a single-oid root ref that points at a missing object', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    // A nonzero absent oid: the all-zero oid is filtered before the object probe, so it would not
    // exercise the missing-object path.
    const missing = '1'.repeat(40)
    const origHeadPath = await gitOutput(repo, 'rev-parse', '--git-path', 'ORIG_HEAD')
    await writeFile(join(repo, origHeadPath), `${missing}\n`)

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('handles linked worktrees whose .git entry is a file', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'auth.json', '{"credential":"placeholder"}')
    const worktree = `${repo}-worktree`
    roots.push(worktree)
    await git(repo, 'worktree', 'add', worktree)

    await expect(assertNoCanonicalSecretsInGit(worktree)).rejects.toThrow(/rotate.*purge.*reflog.*garbage collection/i)
  })

  test('allows a clean linked worktree whose .git entry is a file', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const worktree = `${repo}-clean-worktree`
    roots.push(worktree)
    await git(repo, 'worktree', 'add', worktree)

    await expect(assertNoCanonicalSecretsInGit(worktree)).resolves.toBeUndefined()
  })

  test("rejects a non-commit pinned only by a linked worktree's FETCH_HEAD, scanning from the main worktree", async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const worktree = `${repo}-linked`
    roots.push(worktree)
    await git(repo, 'worktree', 'add', worktree)

    const blob = await gitStdin(repo, 'notes', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')
    const tag = await gitStdin(
      repo,
      `object ${tree}\ntype tree\ntag treetag\ntagger t <test@example.com> 0 +0000\n\nx\n`,
      'hash-object',
      '-w',
      '-t',
      'tag',
      '--stdin',
    )
    // The pseudoref lives under the linked worktree's own per-worktree git dir, so probing only the
    // main worktree would miss it. Resolve the path from inside the linked worktree.
    const linkedFetchHead = await gitOutput(worktree, 'rev-parse', '--git-path', 'FETCH_HEAD')
    const fetchHeadPath = isAbsolute(linkedFetchHead) ? linkedFetchHead : join(worktree, linkedFetchHead)
    await writeFile(fetchHeadPath, `${tag}\t\tbranch x of somewhere\n`)

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({
      ok: false,
      paths: ['unattributable dangling Git objects'],
    })
  })

  test('rejects an arbitrary unlisted root ref (CUSTOM_HEAD) whose tag peels to a tree', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, 'notes', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')
    const tag = await gitStdin(
      repo,
      `object ${tree}\ntype tree\ntag treetag\ntagger t <test@example.com> 0 +0000\n\nx\n`,
      'hash-object',
      '-w',
      '-t',
      'tag',
      '--stdin',
    )
    // CUSTOM_HEAD is not in any fixed pseudoref allowlist; it must be caught by root-ref enumeration.
    const customHeadPath = await gitOutput(repo, 'rev-parse', '--git-path', 'CUSTOM_HEAD')
    await writeFile(join(repo, customHeadPath), `${tag}\n`)

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({
      ok: false,
      paths: ['unattributable dangling Git objects'],
    })
  })

  test('rescans a clean repository and blocks a newly staged canonical secret', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()

    await writeFile(join(repo, 'secrets.json'), '{"credential":"placeholder"}')
    await git(repo, 'add', 'secrets.json')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(GitSecretHistoryError)
  })

  test('caches contamination fail-closed for the process lifetime', async () => {
    const repo = await makeRepo()
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow()
    await git(repo, 'rm', '.env')
    await git(repo, 'commit', '-m', 'remove example credential')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')
    await git(repo, 'gc', '--prune=now')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(GitSecretHistoryError)
  })

  // Skipped on Windows: the old-Git emulation relies on a POSIX `/bin/sh` shim shadowing `git`.
  test.skipIf(isWindows())('denies every transport so a promisor probe never reaches the network', async () => {
    // Emulate unpatched Git <2.45 (silently ignores GIT_NO_LAZY_FETCH) with a `git` shim on PATH
    // that strips the var and routes GIT_TRACE to a file before exec'ing the real git. Probing the
    // missing ORIG_HEAD object on this promisor-configured repo would lazy-fetch the remote; the
    // scan's GIT_ALLOW_PROTOCOL='' fence must deny the `file` transport so `git upload-pack` against
    // the remote never runs. The trace is the observable proof the network stayed untouched.
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')

    const promisor = join(repo, 'promisor.git')
    roots.push(promisor)
    await git(repo, 'init', '--bare', promisor)
    await appendFile(
      join(repo, '.git', 'config'),
      `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = file://${promisor}\n\tpromisor = true\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    )
    const missing = '1'.repeat(40)
    const origHeadPath = await gitOutput(repo, 'rev-parse', '--git-path', 'ORIG_HEAD')
    await writeFile(join(repo, origHeadPath), `${missing}\n`)

    // Resolve the real git absolutely: the shim shadows `git` on PATH, so it must exec the real
    // binary by full path or it would re-invoke itself forever.
    const realGit = await resolveGitBinary()
    const shimDir = await mkdtemp(join(tmpdir(), 'typeclaw-git-shim-'))
    roots.push(shimDir)
    const trace = join(shimDir, 'git-trace.log')
    const shim = join(shimDir, 'git')
    await writeFile(
      shim,
      `#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexport GIT_TRACE=${JSON.stringify(trace)}\nexec ${realGit} "$@"\n`,
    )
    await chmod(shim, 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ''}`
    try {
      await assertNoCanonicalSecretsInGit(repo).catch(() => undefined)
    } finally {
      process.env.PATH = originalPath
    }

    const traceLog = (await Bun.file(trace).exists()) ? await Bun.file(trace).text() : ''
    // The lazy fetch is attempted (proves the promisor path is exercised) but the transport fence
    // denies it before `git upload-pack` ever contacts the remote. Without GIT_ALLOW_PROTOCOL=''
    // this same trace contains upload-pack.
    expect(traceLog).toContain('fetch origin')
    expect(traceLog).not.toContain('upload-pack')
  })
})

async function resolveGitBinary(): Promise<string> {
  const proc = Bun.spawn(['sh', '-c', 'command -v git'], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error('git binary not found')
  return stdout.trim()
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'typeclaw-git-secret-history-'))
  roots.push(repo)
  await git(repo, 'init')
  await git(repo, 'config', 'user.name', 'Test User')
  await git(repo, 'config', 'user.email', 'test@example.com')
  return repo
}

async function commitFile(repo: string, relative: string, content: string): Promise<void> {
  const target = join(repo, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  await git(repo, 'add', relative)
  await git(repo, 'commit', '-m', `add ${relative}`)
}

async function git(repo: string, ...args: string[]): Promise<void> {
  await gitOutput(repo, ...args)
}

async function gitOutput(repo: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${stderr}`)
  return stdout.trim()
}

async function gitStdin(repo: string, stdin: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${stderr}`)
  return stdout.trim()
}
