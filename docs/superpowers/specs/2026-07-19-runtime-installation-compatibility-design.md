# Runtime Installation Compatibility Design

## Goal

Keep TypeClaw's file-snapshot and Git-secret-history protections active when an agent runs from a Bun-installed package tree and a host-owned agent directory is bind-mounted into a root-run container.

## Scope

This change fixes two observed failures:

1. A bundled plugin's `SKILL.md` can be a Bun hardlink under `node_modules`, but generic file-tool snapshotting rejects every multi-linked file.
2. Git's `safe.directory` ownership check prevents the internal Git-secret-history scan from running against `/agent`; the scanner currently reports that operational error as credential-history contamination and disables all model bash.

The change does not broaden model access to credentials, permit user-controlled hardlinks, or weaken canonical-secret history detection.

## Design

### Installed skill files

File snapshots retain the single-hardlink requirement by default. A narrow exception permits a multi-linked regular file only when it is a `SKILL.md` whose resolved path is under an installed package's `node_modules/<package>/skills/` tree. The exception is structural, not name-only: the path must be below the agent's real `node_modules` root and the file remains subject to the existing inode, link-count, size, canonical-secret, and immutable-copy checks. The snapshot rechecks the authorized inode and link count after opening the file, so a link added while waiting for snapshot capacity still fails closed.

This permits Bun's content-addressed installation layout for package-provided skills while preserving the hardlink rejection for every operator-controlled input, including arbitrary files under the agent root or workspace.

### Internal Git metadata scan

The scanner's Git process receives an injected, otherwise-empty configuration containing only `safe.directory=<real agent directory>`, alongside its existing hookless, no-system-config, no-replace-object and no-network restrictions. This is scanner-private configuration: it does not modify host or container Git configuration and does not grant model-driven Git access to arbitrary global configuration.

Git can therefore inspect the bind-mounted repository even when the runtime UID differs from the host owner. The scanner continues to fail closed for every real Git/object error and every canonical-secret history match.

## Tests

- A two-linked `node_modules/<package>/skills/<name>/SKILL.md` snapshots successfully.
- A two-linked file outside the installed-skill shape remains rejected.
- A Git scan succeeds when Git would reject the working tree as dubious until its generated scanner config marks that exact repository safe.
- Existing canonical secret-history tests remain green, demonstrating the ownership workaround does not suppress contamination detection.

## Operational Effect

After deployment, package-provided skills such as `typeclaw-gws-multi-account` load from Bun installations, and the Git scan no longer turns a routine container/host UID mismatch into a credential-rotation incident. No server-side manual `safe.directory` setting or copied skill files are required.
