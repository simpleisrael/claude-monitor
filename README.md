# claude-monitor

Realtime Claude Code context monitor with idle auto-compact. No dependencies.

```bash
node monitor.js status      # one-shot table of recent sessions + context %
node monitor.js daemon      # watch + auto-compact + dashboard at http://127.0.0.1:4599
node monitor.js install     # launchd agent (runs daemon at login, keeps it alive)
node monitor.js uninstall
node test.js                # self-check
```

## How it works

- Tails `~/.claude/projects/**/*.jsonl` and reads the last assistant message's
  `usage` fields — current context ≈ input + cache_creation + cache_read tokens.
- A session is **idle** when its transcript hasn't been written for `idleMinutes`.
- Idle + context ≥ `compactThresholdPct` → runs `claude -p --resume <id> "/compact"`
  (verified working headlessly from any cwd). One attempt per token level.
- Active + over `notifyThresholdPct` → macOS notification instead (can't compact under you).
- Every action goes to `actions.log`; attempt state in `state.json`.

## Config (`config.json`, hot-reloaded each poll)

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

## Extras

- **Menu bar**: `menubar/claude-monitor.1m.sh` is a SwiftBar/xbar plugin showing the
  worst session's context % and worst weekly limit % (server-rendered by `/api/menubar`).
- **Sparklines + burn rate**: the daemon appends token snapshots to `history.jsonl`
  (5MB rotation); the dashboard draws per-session trend lines and tok/h.
- **5-hour block panel**: shows your current rate-limit block (tokens, cost, reset
  time) via `ccusage blocks` — first load downloads ccusage through npx.
- **Real limit %**: `/api/limits` reads the Claude Code OAuth token from the login
  Keychain and asks Anthropic's usage endpoint for true 5-hour + weekly utilization
  and reset times (the same numbers `/usage` shows). Token never leaves the machine
  except to api.anthropic.com; cached 60s.
- **Compact instructions**: per-project text in the dashboard becomes
  `/compact <instructions>` so summaries keep what matters to that repo.

**Ships in dry-run.** Watch `actions.log` for a day, then set `"dryRun": false`.

Transcript JSONL is an internal Claude Code format — if a CLI update changes it,
only `parseLines()` in monitor.js needs fixing (`node test.js` will tell you).
