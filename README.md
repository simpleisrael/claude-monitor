# claude-monitor

Realtime Claude Code context monitor with idle auto-compact. Zero dependencies.

Watches every Claude Code session on your Mac, shows context %, cost, and real
rate-limit usage on a live dashboard, and runs `/compact` on idle sessions
before they hit the context wall.

## Requirements

- macOS (uses Keychain, launchd, and macOS notifications)
- Node 18+ (`node --version`)
- [Claude Code](https://claude.com/claude-code) logged in on this machine

## Install

**Homebrew**

```bash
brew install simpleisrael/tap/claude-monitor
claude-monitor install
```

**From source**

```bash
git clone https://github.com/simpleisrael/claude-monitor
cd claude-monitor
node monitor.js install
```

`install` registers a launchd agent: the daemon starts now, restarts at login,
and stays alive. Open **http://127.0.0.1:4599** — that's the dashboard.

## Commands

```bash
claude-monitor status      # one-shot terminal table of sessions + context %
claude-monitor daemon      # run the daemon in the foreground (install does this for you)
claude-monitor install     # launchd agent (start at login, keep alive) + dashboard
claude-monitor uninstall   # stop and remove the launchd agent
node test.js               # self-check
```

(From a source checkout, use `node monitor.js <command>`.)

## What you get

- **Dashboard** at http://127.0.0.1:4599 — live context % per session
  (active/idle split, sparklines, burn rate), current 5-hour block cost, daily
  and weekly usage tables, and per-project settings.
- **Real limit bars** — your true 5-hour and weekly rate-limit % with reset
  times, the same numbers `/usage` shows, straight from Anthropic's usage
  endpoint (see [Privacy](#privacy--security)).
- **Auto-compact** — a session that goes idle above the threshold gets
  `claude -p --resume <id> "/compact"` run for it automatically.
- **Alerts** — macOS notification when an *active* session crosses the
  threshold (it can't compact under you); optional webhook / Telegram.
- **Menu bar** (optional) — install [SwiftBar](https://swiftbar.app), then copy
  `menubar/claude-monitor.1m.sh` into your SwiftBar plugins folder. Shows the
  worst session's context % and worst weekly limit % at a glance.

## Arming auto-compact

**Ships in dry-run.** Out of the box nothing is compacted; the daemon only logs
`DRYRUN would compact ...` lines to `actions.log`. Watch that for a day, and
when you trust it:

```json
// config.json (next to monitor.js)
{ "dryRun": false }
```

## How it works

- Tails `~/.claude/projects/**/*.jsonl` and reads the last assistant message's
  `usage` fields — current context ≈ input + cache_creation + cache_read tokens.
- A session is **idle** when its transcript hasn't been written for `idleMinutes`.
- Idle + context ≥ `compactThresholdPct` → runs `claude -p --resume <id> "/compact"`
  (verified working headlessly from any cwd). One attempt per token level.
- Active + over `notifyThresholdPct` → macOS notification instead.
- Every action goes to `actions.log`; attempt state in `state.json`.

## Config (`config.json`, hot-reloaded each poll)

Created next to monitor.js on first edit from the dashboard, or write it by hand.

| key | default | |
|---|---|---|
| `compactThresholdPct` | 80 | auto-compact idle sessions at/above this |
| `notifyThresholdPct` | 80 | notify for active sessions |
| `idleMinutes` | 10 | idle definition |
| `dryRun` | **true** | logs what it *would* compact — set `false` to arm |
| `pollSeconds` | 30 | scan interval (fs.watch also triggers instantly) |
| `staleHours` | 72 | ignore sessions older than this |
| `excludeProjects` | `["-private-"]` | substring match on project dir name |
| `contextWindows` | 200k default, fable-5 1M | per-model window sizes |
| `perProject` | `{}` | per-project overrides: `{ "<project-dir>": { "compactThresholdPct": 90, "disabled": true } }` — editable from the dashboard's Projects strip |

Optional alert channels (both off until filled in):

- `webhookUrl` — POSTs `{title, body}` JSON on every alert
- `telegram: { botToken, chatId }` — Telegram sendMessage on every alert

Per-project **compact instructions** (dashboard → Projects) become
`/compact <instructions>` so summaries keep what matters to that repo.

## Privacy & security

- The dashboard binds **127.0.0.1 only** — nothing is reachable from the network.
- The real-limit feature reads the Claude Code OAuth token from your login
  Keychain and sends it to **api.anthropic.com only**, cached 60s, last good
  response kept in `limits.json`. The token is never logged or stored.
- Usage/cost tables use [ccusage](https://github.com/ryoppippi/ccusage) via
  npx (pinned version), reading your local transcripts.

## Updating

```bash
brew upgrade claude-monitor        # Homebrew
# or, from source:
git pull && node monitor.js install
```

## Uninstall

```bash
claude-monitor uninstall           # remove the launchd agent
brew uninstall claude-monitor      # if installed via Homebrew
```

---

Transcript JSONL is an internal Claude Code format — if a CLI update changes it,
only `parseLines()` in monitor.js needs fixing (`node test.js` will tell you).
