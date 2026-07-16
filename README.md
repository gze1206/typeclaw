<p align="center">
  <img src="./docs/public/typeclaw-transparent.png" alt="TypeClaw logo" width="240" />
</p>

<h3 align="center">TypeClaw: The agent for perfectionists</h3>
<p align="center">Crafted in every detail – it behaves in your team's chat and<br />gets sharper the longer it runs. Sandboxed and self-managing.</p>

<p align="center">
  <a href="https://discord.gg/V4NQnbXpr"><img src="https://img.shields.io/badge/Discord-Chat%20with%20Typeey-5865F2?logo=discord&logoColor=white" alt="Chat with Typeey on Discord" /></a>
</p>

<br />
<br />

## Self-improving — a learning loop, not a black box

- 🌱 **Memory** — logs its own work to a daily stream as it goes
- 💤 **Dreaming** — a subagent distills each day's work into long-term memory, committed to git as plain files you can read, diff, and revert
- 🧠 **Muscle memory** — recurring procedures become reusable skills it writes for itself and loads on later runs
- 🔎 **Optional embedding recall** — hybrid keyword-and-embedding search over the same markdown memory, off by default; the plain files remain the durable source of truth

## Group chat — knows when not to talk

- 👥 **Room awareness** — knows who's present and tells humans from bots, so it stays quiet when people are talking to each other rather than chiming in on messages it wasn't part of
- 💬 **Sticky engagement** — holds an ongoing thread after replying without needing to be re-mentioned, then steps back when the conversation moves on; multilingual continuation detection, peer-bot loop guards, and flood filters keep it from spiraling

## Channels — one agent, many inboxes

- 📨 **Supported channels** — Slack, Discord, Telegram, Webex, Teams, Instagram, LINE, KakaoTalk, GitHub, and a websocket TUI, driven by the same agent
- 🔎 **Cross-channel reading** — beyond the conversation it's in, it can read another channel's history, pull a single message by id, or list a workspace's channels on demand, so "check what's going on in #general" or "what do you make of this message?" just works
- ✅ **Pull-request review** — treats a GitHub PR as a conversation, reviewing as a participant, with guards against claiming a verdict it didn't actually post and against leaving a PR stranded

## Web & research — reads the web like a person

- 🔍 **Live web search & fetch** — pull a page as a readable article, a JSON query, a selected slice, a grep, or raw
- 🛡️ **Rebinding-safe page fetching** — validates every A/AAAA answer on the socket lookup and every redirect hop; private and mixed-address targets fail closed
- 🌐 **Interactive browser sessions** — drives a browser on live pages, with a dashboard you can step into for logins, 2FA, or CAPTCHA

## Security — defense-in-depth for risky actions

- 🛡 **Layered guards** — stop secret exfiltration, SSRF, prompt injection, rogue git pushes, and silent privilege escalation before they fire
- 🪪 **Roles** — owner, trusted, member, and guest gate privileged actions
- 🔑 **Permissions** — per-channel match rules decide who can ask for what; an untrusted channel user can't trigger privileged behavior
- 🔒 **Encryption at rest** — sensitive channel passwords are sealed with authenticated encryption; the key is host-held and isn't passed into the container during normal operation

## Isolation & sandbox — runs clean, stays out of each other's way

- 🐳 **No machine clutter** — agent runtime state lives in its own folder and container; apart from the TypeClaw CLI install, it doesn't scatter services or config across your machine, and stopping it shuts the running pieces down, leaving a folder you can keep, copy, or delete
- 🧩 **No cross-agent interference** — run as many as you like; each gets its own container, files, memory, and even its own browser, so one can read a page while another drives a different one
- 📁 **Self-contained folder** — settings, memory, and connections live together in the agent's folder, kept as a version history you can review, undo, or back up

## Subagents — delegation in a fresh context

- 🪄 **A bench of specialists** — it hands off research, planning, code review, and hands-on execution to focused child sessions, each with its own prompt, tools, and model
- 🔀 **Sync or background** — spawn and block for a result, or spawn in the background and collect completions later; coalescing prevents duplicate concurrent runs and depth limits keep delegation chains bounded

## Extensibility — teach it new tricks in TypeScript

- 🔌 **Plugins are just imports** — a plugin is a plain TypeScript file that imports the runtime and adds tools, skills, channels, and commands; no IPC, no FFI, no DSL, distributed as packages and resolved like any dependency
- 🛰 **MCP support** — connect external MCP servers over stdio or HTTP; their tools become the agent's tools. HTTP servers authenticate with OAuth (`typeclaw mcp auth`) or static headers/bearer tokens, and per-server `allowTools`/`denyTools` keep a third-party server to the tools you meant to grant it
- 📚 **Skills on demand** — markdown procedures load lazily when selected, so they avoid prompt-token cost until used; skills layer from bundled, your own, and what the agent learns
- ⚙️ **Typed config with hot reload** — most config changes take effect live; boot-only fields are flagged restart-required

## Connectivity — reachable wherever you need it

- 🌍 **Auto port-forward** — services inside the container appear on your `localhost`, including loopback-only ones
- 🚇 **Public tunnels** — a zero-signup public URL out of the box, or bring your own; webhooks self-register at the resulting URL
- 🔗 **Private network access** — forwarded ports can publish to a private network when configured

## Self-managing — operational autonomy, on a budget

- 💾 **Self-backup** — commits and pushes its own state during idle windows, with a generated commit message
- 🔁 **Self-restart** — can rebuild and restart its own container when it needs to, through the host daemon
- ♻️ **Self-continuation** — keeps working through an unfinished task list when you step away, bounded by a turn, token, and wall-clock budget

## Operator CLI — see what it's doing and what it costs

- 🩺 **doctor** — diagnoses host, agent folder, config, and channels, with auto-fix for managed files
- 📊 **usage** — reports token and dollar spend by day, model, session, or origin
- 🔍 **inspect** — replays a session transcript and tails live activity
- 📜 **logs** — streams container logs with local-time prefixes

## Compose — manage a fleet from the CLI

- 🎼 **Fleet operations** — discover agent folders and start, stop, restart, check status, tail logs, report usage, and run diagnostics across them from the command line

Memory loop and subagent architecture are covered in detail in the [Internals docs](https://typeclaw.dev/docs/internals) and [`src/bundled-plugins/memory/README.md`](./src/bundled-plugins/memory/README.md).

## Install

```sh
bun add -g typeclaw
```

Requires Bun ≥ 1.1 and Docker (or OrbStack) on the host.

## Quickstart

```sh
mkdir my-agent && cd my-agent
typeclaw init        # scaffold, build, run the container, and attach a TUI
```

That's it. `init` hatches the agent end to end — it scaffolds the folder (`typeclaw.json`, `.env`, `Dockerfile`, `package.json`), builds and runs the container, then drops you into a terminal UI. The agent is now alive, listening on a websocket, ready to receive prompts from the TUI or any wired channel.

For later sessions, `typeclaw start` runs the container and `typeclaw tui` re-attaches. See `typeclaw --help` for the full command surface, or [typeclaw.dev](https://typeclaw.dev) for guides and configuration reference.

## Development

```sh
git clone https://github.com/typeclaw/typeclaw
cd typeclaw
bun install
bun run test
```

Pre-commit checks (all must pass — no exceptions):

```sh
bun run typecheck
bun run lint
bun run format
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the recommended local dev loop (`bun link` → `typeclaw init`), commit and PR conventions, and where to ask questions. The [Internals docs](https://typeclaw.dev/docs/internals) cover the long-form architecture notes — stages, hostd internals, message stream, plugin contracts, and the testing philosophy. The docs site at [typeclaw.dev](https://typeclaw.dev) lives in [`docs/`](./docs/).

## Acknowledgments

- **Multi-channel** is powered by [agent-messenger](https://github.com/agent-messenger/agent-messenger) — every non-GitHub adapter (`slack-bot`, `discord-bot`, `telegram-bot`, `webex-bot`, `instagram`, `line`, `kakaotalk`) is built on its SDK. Thanks to the maintainers for the credential extraction, listener protocols, and platform coverage that made multi-channel a feature instead of a year-long project.
- **Subagent architecture** is inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu). Thanks for the shape that made this clean.
- **Question-mark attention escalation** ("Jeff Bezos detection") was suggested by [@kdhfred](https://github.com/kdhfred). Thanks for the idea that turned a wall of `?` into a real signal.

## License

MIT
