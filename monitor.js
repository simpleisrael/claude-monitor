#!/usr/bin/env node
'use strict';
// claude-monitor: realtime Claude Code context monitor + idle auto-compact.
// Commands: status | daemon | install | uninstall
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const LOG_PATH = path.join(DIR, 'actions.log');
const HISTORY_PATH = path.join(DIR, 'history.jsonl');

const DEFAULTS = {
  compactThresholdPct: 80,   // auto-compact idle sessions at/above this
  notifyThresholdPct: 80,    // macOS notification for ACTIVE sessions at/above this
  idleMinutes: 10,           // no transcript writes for this long = idle
  dryRun: true,              // log what WOULD compact, don't do it (flip to false to arm)
  pollSeconds: 30,
  port: 4599,
  staleHours: 72,            // ignore sessions idle longer than this
  excludeProjects: ['-private-'], // substring match on project dir name
  contextWindows: { default: 200000, 'claude-fable-5': 1000000 },
  perProject: {},            // { "<dir>": { compactThresholdPct, disabled, compactPrompt } }
  webhookUrl: '',            // optional: POSTs {title, body} JSON on every alert
  telegram: { botToken: '', chatId: '' } // optional: sendMessage on every alert
};

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function logAction(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(LOG_PATH, entry);
  console.log(entry.trim());
}

// ---------------------------------------------------------------- collector

// Read the tail of a transcript and extract the last assistant usage entry.
// JSONL format is internal to Claude Code — all parsing is confined here.
// ponytail: escalating tail reads; a single line >4MB defeats this, rescan catches it next turn.
function tailUsage(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (const chunk of [65536, 1048576, 4194304]) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let lines = buf.toString('utf8').split('\n');
      if (start > 0) lines = lines.slice(1); // first line may be partial
      const res = parseLines(lines);
      if (res || start === 0) return res;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

function parseLines(lines) {
  let usage = null, usageIdx = -1, boundaryIdx = -1, cwd = null, model = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj.cwd) cwd = obj.cwd;
    if (obj.subtype === 'compact_boundary' || obj.isCompactSummary) boundaryIdx = i;
    const u = obj.message && obj.message.usage;
    if (u && obj.message.role === 'assistant' && u.input_tokens !== undefined) {
      usage = u; usageIdx = i; model = obj.message.model || model;
    }
  }
  if (!usage) return null;
  const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  return { tokens, model, cwd, compacted: boundaryIdx > usageIdx };
}

function scan(cfg) {
  const now = Date.now();
  const sessions = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return sessions; }
  for (const dir of dirs) {
    if (cfg.excludeProjects.some(p => dir.includes(p))) continue;
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dirPath, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const idleMs = now - st.mtimeMs;
      if (idleMs > cfg.staleHours * 3600e3) continue;
      const u = tailUsage(file);
      if (!u) continue;
      const window = cfg.contextWindows[u.model] || cfg.contextWindows.default;
      sessions.push({
        project: dir,
        sessionId: f.replace('.jsonl', ''),
        model: u.model,
        cwd: u.cwd,
        tokens: u.compacted ? 0 : u.tokens,
        window,
        pct: u.compacted ? 0 : Math.round((u.tokens / window) * 1000) / 10,
        compacted: u.compacted,
        mtimeMs: st.mtimeMs,
        active: idleMs < cfg.idleMinutes * 60e3
      });
    }
  }
  sessions.sort((a, b) => (b.active - a.active) || (b.pct - a.pct));
  return sessions;
}

// ---------------------------------------------------------------- actions

function compactArgs(s, cfg) {
  const prompt = ((cfg.perProject[s.project] || {}).compactPrompt || '').trim();
  return ['-p', '--resume', s.sessionId, prompt ? `/compact ${prompt}` : '/compact'];
}

function compactSession(s, cfg, cb) {
  execFile('claude', compactArgs(s, cfg), { cwd: s.cwd || undefined, timeout: 300e3 }, (err, stdout, stderr) => {
    cb(err, (stdout || '').trim() || (stderr || '').trim());
  });
}

function notify(title, body) {
  const esc = t => String(t).replace(/["\\]/g, '');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
  const cfg = loadConfig();
  if (cfg.webhookUrl) {
    fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }) }).catch(() => {});
  }
  const tg = cfg.telegram || {};
  if (tg.botToken && tg.chatId) {
    fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: `${title}\n${body}` }) }).catch(() => {});
  }
}

// ponytail: 5MB rotation keeps ~1 month at 30s ticks; .old is the only backfile
function appendHistory(sessions) {
  try {
    if (fs.existsSync(HISTORY_PATH) && fs.statSync(HISTORY_PATH).size > 5e6) {
      fs.renameSync(HISTORY_PATH, HISTORY_PATH + '.old');
    }
    const line = JSON.stringify({ t: Date.now(),
      s: Object.fromEntries(sessions.map(x => [x.sessionId, x.tokens])) });
    fs.appendFileSync(HISTORY_PATH, line + '\n');
  } catch {}
}

function thresholdFor(s, cfg, key) {
  const o = cfg.perProject[s.project];
  return (o && o[key]) || cfg[key];
}

function evaluate(sessions, cfg, state, log = logAction) {
  for (const s of sessions) {
    if (s.compacted) continue;
    const st = state[s.sessionId] || (state[s.sessionId] = {});
    if (s.active) {
      // can't compact under the user — notify instead, once per token level
      if (s.pct >= thresholdFor(s, cfg, 'notifyThresholdPct') && st.notifiedTokens !== s.tokens) {
        st.notifiedTokens = s.tokens;
        notify('Claude context high', `${s.project.slice(-40)}: ${s.pct}% — /compact at a natural break`);
        log(`NOTIFY ${s.sessionId} ${s.pct}% (active) ${s.project}`);
      }
      continue;
    }
    if ((cfg.perProject[s.project] || {}).disabled) continue;
    if (s.pct < thresholdFor(s, cfg, 'compactThresholdPct')) continue;
    // one attempt per token level: only retry if the session grew since last attempt
    if (st.compacting || st.compactedTokens >= s.tokens) continue;
    st.compactedTokens = s.tokens;
    if (cfg.dryRun) {
      log(`DRYRUN would compact ${s.sessionId} at ${s.pct}% (${s.tokens} tok) ${s.project}`);
      continue;
    }
    st.compacting = true;
    log(`COMPACT start ${s.sessionId} at ${s.pct}% (${s.tokens} tok) ${s.project}`);
    compactSession(s, cfg, (err, out) => {
      st.compacting = false;
      log(`COMPACT ${err ? 'FAIL' : 'done'} ${s.sessionId}: ${err ? err.message : out}`.slice(0, 300));
      if (!err) notify('Claude Monitor', `Compacted ${s.project.slice(-40)} (${s.pct}%)`);
    });
  }

}

// ---------------------------------------------------------------- CLI

function cmdStatus() {
  const cfg = loadConfig();
  const sessions = scan(cfg);
  if (!sessions.length) return console.log('No sessions in the last', cfg.staleHours, 'hours.');
  const rows = sessions.map(s => [
    s.active ? '●' : ' ',
    s.pct.toFixed(1).padStart(5) + '%',
    String(s.tokens).padStart(7),
    (s.model || '?').replace('claude-', '').padEnd(12),
    ago(s.mtimeMs).padStart(8),
    s.project.split('-').slice(-3).join('-').slice(0, 40),
    s.sessionId.slice(0, 8) + (s.compacted ? ' [compacted]' : '')
  ].join('  '));
  console.log('  ctx%      tokens  model         last-use  project  session');
  console.log(rows.join('\n'));
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

// ---------------------------------------------------------------- daemon + dashboard

function cmdDaemon() {
  const state = loadState();
  for (const k in state) delete state[k].compacting; // stale in-flight flags from a crash
  const clients = new Set();
  let snapshot = { sessions: [], config: loadConfig(), at: Date.now() };
  const ccusageCache = {};
  function ccusage(sub, ttl, cb) {
    const c = ccusageCache[sub];
    if (c && Date.now() - c.at < ttl) return cb(c.body);
    if (ccusageCache[sub + ':pending']) return cb(c ? c.body : '{"error":"loading"}');
    ccusageCache[sub + ':pending'] = true;
    // ponytail: pinned — @latest re-checks the registry on every cold call
    execFile('npx', ['-y', 'ccusage@20.0.20', sub, '--json'], { timeout: 120e3 }, (err, stdout) => {
      delete ccusageCache[sub + ':pending'];
      if (!err) ccusageCache[sub] = { at: Date.now(), body: stdout };
      cb(err ? (c ? c.body : JSON.stringify({ error: String(err.message).slice(0, 200) })) : stdout);
    });
  }
  function activeBlock() {
    try { return JSON.parse(ccusageCache.blocks.body).blocks.find(b => b.isActive) || null; }
    catch { return null; }
  }
  // Real rate-limit utilization (5h + weekly) from Anthropic's OAuth usage endpoint,
  // using the Claude Code token in the login Keychain. Token stays on this machine.
  // last good response persists to disk so restarts / endpoint outages serve stale data
  const LIMITS_PATH = path.join(DIR, 'limits.json');
  let limitsCache = null, limitsPending = false, limitsAttempt = 0, limitsErr = 'loading';
  try { limitsCache = JSON.parse(fs.readFileSync(LIMITS_PATH, 'utf8')); } catch {}
  function limits(cb) {
    if (limitsCache && Date.now() - limitsCache.at < 60e3) return cb(limitsCache.body);
    const stale = () => cb(limitsCache ? limitsCache.body : JSON.stringify({ error: limitsErr }));
    // 60s between attempts even on failure — a retry storm here earns a 429
    if (limitsPending || Date.now() - limitsAttempt < 60e3) return stale();
    limitsPending = true; limitsAttempt = Date.now();
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 10e3 }, (err, stdout) => {
        const fail = m => { limitsPending = false; limitsErr = m; stale(); };
        if (err) return fail('keychain: ' + String(err.message).slice(0, 120));
        let token;
        try { token = JSON.parse(stdout.trim()).claudeAiOauth.accessToken; }
        catch { return fail('unexpected credential format'); }
        fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
        }).then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
          .then(body => {
            limitsPending = false; limitsCache = { at: Date.now(), body };
            try { fs.writeFileSync(LIMITS_PATH, JSON.stringify(limitsCache)); } catch {}
            cb(body);
          })
          .catch(e => fail(String(e.message).slice(0, 120)));
      });
  }

  function tick() {
    const cfg = loadConfig(); // hot-reload config each tick
    const sessions = scan(cfg);
    evaluate(sessions, cfg, state);
    for (const k of Object.keys(state)) // prune state for sessions that aged out
      if (!state[k].compacting && !sessions.some(s => s.sessionId === k)) delete state[k];
    saveState(state);
    appendHistory(sessions);
    ccusage('blocks', 90e3, () => {}); // keep block data warm for menubar + dashboard
    limits(() => {}); // keep limit % warm for menubar (60s cache)
    snapshot = { sessions, config: cfg, at: Date.now() };
    const data = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of clients) res.write(data);
  }

  tick();
  setInterval(tick, loadConfig().pollSeconds * 1000);
  let debounce;
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, () => {
      clearTimeout(debounce); debounce = setTimeout(tick, 2000);
    });
  } catch { /* poll still covers it */ }

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(path.join(DIR, 'index.html')));
    } else if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } else if (req.url === '/api/log') {
      let log = '';
      try { log = fs.readFileSync(LOG_PATH, 'utf8'); } catch {}
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(log.split('\n').slice(-50).join('\n'));
    } else if (req.url === '/api/limits') {
      limits(body => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    } else if (req.url === '/api/ccusage' || req.url === '/api/blocks') {
      const sub = req.url === '/api/blocks' ? 'blocks' : 'daily';
      ccusage(sub, sub === 'blocks' ? 60e3 : 300e3, body => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    } else if (req.url === '/api/history') {
      let lines = [];
      try {
        lines = fs.readFileSync(HISTORY_PATH, 'utf8').trim().split('\n').slice(-400)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lines));
    } else if (req.url === '/api/menubar') {
      const cfg2 = snapshot.config;
      const live = snapshot.sessions.filter(x => !x.compacted);
      const worst = live[0] ? live.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
      const dot = p => p >= cfg2.compactThresholdPct ? '🔴' : p >= cfg2.compactThresholdPct * 0.75 ? '🟡' : '🟢';
      const out = [worst ? `${dot(worst.pct)} ${Math.round(worst.pct)}%` : 'CC –', '---'];
      for (const x of snapshot.sessions) {
        out.push(`${x.active ? '●' : '○'} ${String(Math.round(x.pct)).padStart(3)}%  ` +
          `${x.project.split('-').slice(-2).join('-').slice(0, 28)}  ${(x.model || '').replace('claude-', '')}` +
          `${x.compacted ? ' [compacted]' : ''} | font=Menlo size=12`);
      }
      const blk = activeBlock();
      if (blk) {
        const mins = Math.max(0, Math.round((new Date(blk.endTime) - Date.now()) / 60000));
        const rate = blk.burnRate ? ` · $${Math.round(blk.burnRate.costPerHour)}/h` : '';
        out.push('---', `Block $${(blk.costUSD || 0).toFixed(2)}${rate} · resets ${Math.floor(mins / 60)}h${mins % 60}m | font=Menlo size=12`);
      }
      try { // weekly limit % from the OAuth usage cache (warmed each tick)
        const wk = (JSON.parse(limitsCache.body).limits || []).filter(l => l.group === 'weekly');
        if (wk.length) {
          out[0] += ` · W${Math.max(...wk.map(l => l.percent))}%`;
          const when = new Date(wk[0].resets_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
          out.push('---', wk.map(l => `${(l.scope && l.scope.model && l.scope.model.display_name) || 'Weekly'} ${l.percent}%`).join(' · ')
            + ` · resets ${when} | font=Menlo size=12`);
        }
      } catch {}
      out.push('---', `Open dashboard | href=http://127.0.0.1:${cfg2.port}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.join('\n') + '\n');
    } else if (req.url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { project, compactThresholdPct, disabled, compactPrompt } = JSON.parse(body);
          if (typeof project !== 'string' || !project) throw new Error('project required');
          let userCfg = {};
          try { userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
          const pp = userCfg.perProject = userCfg.perProject || {};
          const entry = pp[project] = pp[project] || {};
          if (compactThresholdPct == null || compactThresholdPct === '') delete entry.compactThresholdPct;
          else entry.compactThresholdPct = Math.min(100, Math.max(10, Number(compactThresholdPct)));
          if (disabled) entry.disabled = true; else delete entry.disabled;
          if (compactPrompt && String(compactPrompt).trim()) entry.compactPrompt = String(compactPrompt).trim().slice(0, 500);
          else if (compactPrompt !== undefined) delete entry.compactPrompt;
          if (!Object.keys(entry).length) delete pp[project];
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
          logAction(`CONFIG ${project} -> ${JSON.stringify(entry)}`);
          tick();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) { res.writeHead(400); res.end(String(e.message || e)); }
      });
    } else if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'
      });
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else { res.writeHead(404); res.end(); }
  });
  const port = loadConfig().port;
  server.listen(port, '127.0.0.1', () =>
    logAction(`DAEMON started http://127.0.0.1:${port} dryRun=${loadConfig().dryRun}`));
}

// ---------------------------------------------------------------- launchd

const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.trademanager.claude-monitor.plist');
function cmdInstall() {
  const node = process.execPath;
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.trademanager.claude-monitor</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string><string>${path.join(DIR, 'monitor.js')}</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(DIR, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(DIR, 'daemon.log')}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
  </dict>
</dict></plist>\n`);
  execFile('launchctl', ['unload', PLIST], () =>
    execFile('launchctl', ['load', PLIST], err =>
      console.log(err ? `launchctl load failed: ${err.message}` : `Installed + started. Dashboard: http://127.0.0.1:${loadConfig().port}`)));
}
function cmdUninstall() {
  execFile('launchctl', ['unload', PLIST], () => {
    try { fs.unlinkSync(PLIST); } catch {}
    console.log('Uninstalled.');
  });
}

// ---------------------------------------------------------------- main

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') cmdStatus();
  else if (cmd === 'daemon') cmdDaemon();
  else if (cmd === 'install') cmdInstall();
  else if (cmd === 'uninstall') cmdUninstall();
  else console.log('usage: monitor.js [status|daemon|install|uninstall]');
}

module.exports = { parseLines, tailUsage, scan, evaluate, compactArgs, loadConfig, DEFAULTS };
