# Runtime Installation Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Bun-installed package skills and host-owned bind-mounted agent repositories to run without disabling TypeClaw's snapshot or Git-secret-history protections.

**Architecture:** Direct file snapshots retain their default one-link requirement, with a structural exception only for package `SKILL.md` files below the agent's real `node_modules` root. The initial authorization records the file link count and the open-time check requires the same inode and link count. The Git scanner supplies only the current real agent directory through Git's process-local configuration environment, so Git accepts the bind mount while all existing scanner restrictions remain in force.

**Tech Stack:** TypeScript, Bun test runner, Node.js filesystem APIs, Git configuration environment variables.

## Global Constraints

- Keep canonical-secret path denial and Git canonical-secret history detection fail-closed.
- Do not alter global or repository Git configuration; scanner configuration is child-process-only.
- Do not permit arbitrary hardlinked files; accept only `node_modules/<package>/skills/**/SKILL.md` after resolving the real `node_modules` root.
- Recheck the authorized device, inode, and hardlink count after opening an accepted input.
- Run `bun run typecheck`, `bun run lint`, and `bun run format` before each commit.

---

### Task 1: Permit Bun-linked package skill snapshots without relaxing other file inputs

**Files:**

- Modify: `src/agent/tool-file-safety.ts:22-28, 97-126, 792-799`
- Test: `src/agent/plugin-tools.test.ts:1760-1843`

**Interfaces:**

- Consumes: `enforceAndPinToolFiles({ tool, args, agentDir })` and direct `read` file operands.
- Produces: `isInstalledPackageSkill(agentDir: string, resolved: string): Promise<boolean>` and a `VerifiedInput.nlink: number` authorization invariant.

- [ ] **Step 1: Write the failing package-skill snapshot test**

Add this test immediately before the existing direct hardlink-race test:

```ts
test('snapshots a Bun-style hardlinked package SKILL.md', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-package-skill-hardlink-'))
  const cacheFile = path.join(agentDir, 'bun-cache-skill.md')
  const skill = path.join(agentDir, 'node_modules', 'example-package', 'skills', 'example', 'SKILL.md')
  await mkdir(path.dirname(skill), { recursive: true })
  await writeFile(cacheFile, 'package skill')
  await link(cacheFile, skill)
  const args: Record<string, unknown> = { path: skill }
  try {
    expect((await stat(skill)).nlink).toBe(2)
    const pinned = await enforceAndPinToolFiles({ tool: 'read', args, agentDir })
    expect(await readFile(args.path as string, 'utf8')).toBe('package skill')
    await pinned.cleanup()
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the focused test to verify it fails for the current hardlink policy**

Run: `bun test src/agent/plugin-tools.test.ts --test-name-pattern "Bun-style hardlinked package SKILL"`

Expected: FAIL with `tool input has 2 hard links and cannot be snapshotted safely`.

- [ ] **Step 3: Write the failing non-skill hardlink regression test**

Add this test after the package-skill test:

```ts
test('keeps a hardlinked non-skill package file blocked', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-package-nonskill-hardlink-'))
  const cacheFile = path.join(agentDir, 'bun-cache-readme.md')
  const file = path.join(agentDir, 'node_modules', 'example-package', 'README.md')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(cacheFile, 'not a skill')
  await link(cacheFile, file)
  try {
    await expect(enforceAndPinToolFiles({ tool: 'read', args: { path: file }, agentDir })).rejects.toThrow(
      /hard links.*unique regular file/i,
    )
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 4: Run the two focused tests to verify the new exception is not implemented**

Run: `bun test src/agent/plugin-tools.test.ts --test-name-pattern "hardlinked package"`

Expected: the package `SKILL.md` test fails; the non-skill rejection test passes.

- [ ] **Step 5: Implement the structural exception and link-count recheck**

In `src/agent/tool-file-safety.ts`, add `nlink: number` to `VerifiedInput`. Resolve `join(agentDir, 'node_modules')` with `realpath`, calculate a relative path from that root, and return true only for unscoped `node_modules/<package>/skills/**/SKILL.md` or scoped `node_modules/@<scope>/<package>/skills/**/SKILL.md` paths. Store the inspected link count in each verified file input. Change `assertSingleLinkRegularFile` to accept `allowHardlinks` and preserve its current rejection unless that boolean is true. After `openInput`, reject when `opened.dev`, `opened.ino`, or `opened.nlink` differs from the authorization record before streaming the immutable copy.

```ts
type VerifiedInput = {
  target: FileTarget
  original: string
  resolved: string
  dev: number
  ino: number
  size: number
  nlink: number
  kind: 'file' | 'directory'
}

function assertSingleLinkRegularFile(stats: Stats, original: string, allowHardlinks = false): void {
  if (!stats.isFile()) throw new Error(`tool input changed to a non-regular file before snapshot: ${original}`)
  if (stats.nlink !== 1 && !allowHardlinks) {
    throw new Error(
      `tool input has ${stats.nlink} hard links and cannot be snapshotted safely; copy it to a unique regular file before retrying: ${original}`,
    )
  }
}
```

- [ ] **Step 6: Run the focused snapshot tests to verify they pass**

Run: `bun test src/agent/plugin-tools.test.ts --test-name-pattern "hardlinked package|direct snapshots reject a file hardlinked|recursive directory snapshots reject"`

Expected: PASS; the package skill snapshots, the non-skill file and canonical-secret aliases remain blocked.

- [ ] **Step 7: Commit the tested snapshot change**

```bash
git add src/agent/tool-file-safety.ts src/agent/plugin-tools.test.ts
git commit -m "fix: allow hardlinked package skills"
```

### Task 2: Scope Git safe-directory configuration to the internal scanner

**Files:**

- Modify: `src/git/secret-history.ts:1-5, 316-344`
- Test: `src/git/secret-history.test.ts:1-13, 18-30, 489-540`

**Interfaces:**

- Consumes: `scanCanonicalSecretsInGit(agentDir)` and Git's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0` environment protocol.
- Produces: `buildGitScanEnv(agentDir: string): Promise<Record<string, string>>`, used exclusively by `spawnGit`.

- [ ] **Step 1: Write the failing scanner-environment test**

Import `buildGitScanEnv` and add this test near the clean-repository test:

```ts
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
```

Add `realpath` to the existing `node:fs/promises` import.

- [ ] **Step 2: Run the focused test to verify it fails because the environment builder does not exist**

Run: `bun test src/git/secret-history.test.ts --test-name-pattern "scanner-only configuration"`

Expected: FAIL at module compilation because `buildGitScanEnv` is not exported.

- [ ] **Step 3: Implement scanner-only safe-directory environment construction**

Import `realpath` from `node:fs/promises`. Extract the existing `Bun.spawn` environment object into this function, preserving every current restriction and appending only the real agent directory as the injected Git configuration:

```ts
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
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
  }
}
```

Set `env: await buildGitScanEnv(agentDir)` in `spawnGit`.

- [ ] **Step 4: Run the focused configuration and full Git-secret-history tests**

Run: `bun test src/git/secret-history.test.ts`

Expected: PASS; the new test accepts a Git-test-simulated ownership mismatch and existing tests still report canonical secret paths and replacement refs.

- [ ] **Step 5: Commit the tested Git scanner change**

```bash
git add src/git/secret-history.ts src/git/secret-history.test.ts
git commit -m "fix: trust bind-mounted agent for git scan"
```

### Task 3: Update documentation and run the branch verification suite

**Files:**

- Modify: `docs/superpowers/specs/2026-07-19-runtime-installation-compatibility-design.md`
- Create: `docs/superpowers/plans/2026-07-19-runtime-installation-compatibility.md`

**Interfaces:**

- Consumes: the completed snapshot and Git-scanner behavior from Tasks 1 and 2.
- Produces: operator-facing development notes that explain why no host-level `git config --global safe.directory` workaround is required.

- [ ] **Step 1: Verify the design document names the final protections**

Confirm the installed-skill section states that the open-time device, inode, and link-count recheck remains mandatory, and the Git section states that `safe.directory` is injected into the scanner process rather than persisted in Git configuration.

- [ ] **Step 2: Run focused regression tests**

Run: `bun test src/agent/plugin-tools.test.ts --test-name-pattern "hardlinked package|direct snapshots reject a file hardlinked|recursive directory snapshots reject" && bun test src/git/secret-history.test.ts`

Expected: PASS.

- [ ] **Step 3: Run repository checks**

Run:

```bash
bun run typecheck
bun run lint
bun run format
```

Expected: typecheck and format succeed; lint exits zero with only pre-existing warnings, if any.

- [ ] **Step 4: Inspect the final diff and commit documentation**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short
git add docs/superpowers/specs/2026-07-19-runtime-installation-compatibility-design.md docs/superpowers/plans/2026-07-19-runtime-installation-compatibility.md
git commit -m "docs: document runtime installation safeguards"
```

Expected: only the two documentation files are staged for this documentation commit.
