'use strict';
// Self-check for the transcript parser + compact decision logic. Run: node test.js
const assert = require('assert');
const { parseLines, evaluate, compactArgs, DEFAULTS } = require('./monitor');

const usage = (cr, cc = 0, inp = 2) => JSON.stringify({
  cwd: '/Users/x/proj',
  message: { role: 'assistant', model: 'claude-opus-5', usage: {
    input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: 10 } }
});

// picks the LAST assistant usage line, sums input-side tokens, carries cwd/model
let r = parseLines([usage(1000), '{"type":"mode"}', 'garbage{{{', usage(150000, 400)]);
assert.strictEqual(r.tokens, 150402);
assert.strictEqual(r.model, 'claude-opus-5');
assert.strictEqual(r.cwd, '/Users/x/proj');
assert.strictEqual(r.compacted, false);

// compact boundary AFTER last usage → compacted
r = parseLines([usage(180000), JSON.stringify({ subtype: 'compact_boundary' })]);
assert.strictEqual(r.compacted, true);

// boundary BEFORE a newer usage line → not compacted
r = parseLines([JSON.stringify({ isCompactSummary: true }), usage(5000)]);
assert.strictEqual(r.compacted, false);

// no usage at all → null
assert.strictEqual(parseLines(['{"type":"mode"}']), null);

// evaluate: idle session over threshold gets one dry-run attempt, no retry at same tokens
const logs = [];
const log = l => logs.push(l);
const cfg = { ...DEFAULTS, dryRun: true };
const s = { sessionId: 'abc', project: 'p', tokens: 170000, window: 200000, pct: 85,
  active: false, compacted: false };
const state = {};
evaluate([s], cfg, state, log);
assert.strictEqual(state.abc.compactedTokens, 170000);
evaluate([s], cfg, state, log); // same tokens → still one attempt recorded
assert.strictEqual(state.abc.compactedTokens, 170000);
evaluate([{ ...s, tokens: 180000, pct: 90 }], cfg, state, log); // grew → retry allowed
assert.strictEqual(state.abc.compactedTokens, 180000);
assert.strictEqual(logs.filter(l => l.startsWith('DRYRUN')).length, 2);

// under threshold → untouched
const state2 = {};
evaluate([{ ...s, tokens: 100000, pct: 50 }], cfg, state2, log);
assert.strictEqual(state2.abc.compactedTokens, undefined);

// per-project disabled → never compacts, even over threshold
const state3 = {};
evaluate([s], { ...cfg, perProject: { p: { disabled: true } } }, state3, log);
assert.strictEqual(state3.abc.compactedTokens, undefined);

// per-project threshold override wins over global
const state4 = {};
evaluate([{ ...s, pct: 85 }], { ...cfg, perProject: { p: { compactThresholdPct: 90 } } }, state4, log);
assert.strictEqual(state4.abc.compactedTokens, undefined); // 85 < 90 override

// compactArgs: bare /compact by default, per-project instructions appended
assert.deepStrictEqual(compactArgs(s, cfg), ['-p', '--resume', 'abc', '/compact']);
assert.deepStrictEqual(
  compactArgs(s, { ...cfg, perProject: { p: { compactPrompt: 'keep decisions' } } }),
  ['-p', '--resume', 'abc', '/compact keep decisions']);

console.log('all checks passed');
