'use strict';
// node --test tools/munder/reviver.test.cjs
//
// The Reviver against REAL processes: a fake Munder (node) that answers the
// same authenticated `GET /salud` the app serves, writes munder-control.json
// into its userData, spawns an "agent" child, and cleans up on a clean quit.
// Nothing here is mocked except the clock in the watchdog tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const R = require('./lib-reviver.cjs');
const CLI = require('./reviver.cjs');

const OFFICE = 'a1b2c3d4e5f60718';
const OTHER = 'ffffeeeeddddcccc';

const FAKE = `'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ud = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const read = (f, d) => { try { return fs.readFileSync(path.join(ud, f), 'utf8').trim(); } catch { return d; } };
const mode = read('mode', 'ok');
if (mode === 'crash') { console.error('fake munder: boom'); process.exit(1); }
// Like the app: an agent it closes on quit, a Chromium helper (same exe,
// --type=) and a detached daemon that must outlive it (Munder Link).
const keep = (p) => fs.appendFileSync(path.join(ud, 'children'), p.pid + '\\n');
const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'munder-agent'], { stdio: 'ignore' });
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--type=renderer'], { stdio: 'ignore' });
const link = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'link-serve'], { stdio: 'ignore', detached: true });
link.unref();
[agent, helper, link].forEach(keep);
fs.writeFileSync(path.join(ud, 'agent.pid'), String(agent.pid));
fs.writeFileSync(path.join(ud, 'helper.pid'), String(helper.pid));
fs.writeFileSync(path.join(ud, 'link.pid'), String(link.pid));
const token = crypto.randomBytes(12).toString('hex');
const office = read('office', null);
const control = path.join(ud, 'munder-control.json');
const server = http.createServer((req, res) => {
  if (req.url !== '/salud' || req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{"ok":false}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'munder-control', instance: { pid: process.pid, version: '9.9.9-test', office_id: office, started_at: new Date().toISOString() } }));
});
const quit = () => { try { fs.unlinkSync(control); } catch {} try { agent.kill(); } catch {} server.close(); process.exit(0); };
if (mode !== 'raw-sigterm') process.on('SIGTERM', quit); // raw: like Electron, SIGTERM just ends it
setInterval(() => { if (fs.existsSync(path.join(ud, 'quit'))) { fs.unlinkSync(path.join(ud, 'quit')); quit(); } }, 100);
if (mode !== 'silent') {
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(control, JSON.stringify({ port: server.address().port, token }), { mode: 0o600 });
  });
} else { setInterval(() => {}, 1000); }
`;

const spawned = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killHard = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

async function until(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

function setup(t, { office = OFFICE, mode = 'ok', exe = process.execPath, watchdog = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviver-'));
  const dir = path.join(root, 'reviver');
  const ud = path.join(root, 'userData');
  fs.mkdirSync(ud, { recursive: true });
  const script = path.join(root, 'fake-munder.cjs');
  fs.writeFileSync(script, FAKE);
  fs.writeFileSync(path.join(ud, 'office'), office);
  fs.writeFileSync(path.join(ud, 'mode'), mode);
  const config = {
    office_id: OFFICE,
    target: { exe, args: [script, `--user-data-dir=${ud}`], cwd: root },
    user_data: ud, bind: '127.0.0.1', port: 0,
    health_timeout_ms: 15_000, stop_timeout_ms: 3_000, probe_timeout_ms: 1_500,
    watchdog: { ...R.DEFAULT_WATCHDOG, interval_ms: 1_000, ...watchdog },
  };
  R.saveConfig(dir, config);
  const lines = [];
  const reviver = new R.Reviver({ dir, log: (m) => lines.push(m) });
  const env = { root, dir, ud, script, config, reviver, lines };
  t.after(() => {
    for (const pid of spawned) killHard(pid);
    for (const dirUd of [ud, ...fs.readdirSync(root).filter((d) => d.startsWith('other-')).map((d) => path.join(root, d))]) {
      try { for (const pid of fs.readFileSync(path.join(dirUd, 'children'), 'utf8').split('\n').filter(Boolean)) killHard(Number(pid)); } catch { /* none */ }
    }
    spawned.clear();
  });
  return env;
}

/** Track every pid a receipt says we launched, so the test cleans up even on failure. */
function track(r) {
  if (r && r.start && r.start.pid) spawned.add(r.start.pid);
  return r;
}

function bystander(args) {
  const p = spawn(process.execPath, args, { stdio: 'ignore', detached: true });
  p.unref();
  spawned.add(p.pid);
  return p.pid;
}

test('status reports Munder down (no process, no channel) and not healthy', async (t) => {
  const { reviver } = setup(t);
  const s = await reviver.status();
  assert.equal(s.munder.state, 'down');
  assert.equal(s.healthy, false);
  assert.equal(s.munder.running, false);
  assert.equal(s.office.expected, OFFICE);
  assert.equal(s.target.exists, true);
});

test('start: launched → health passes → identity matches → healthy receipt', async (t) => {
  const { reviver, dir, ud } = setup(t);
  const r = track(await reviver.start('test'));
  assert.equal(r.verdict, 'healthy', r.reason);
  assert.equal(r.ok, true);
  assert.equal(r.before.state, 'down');
  assert.equal(r.start.spawned, true);
  assert.equal(r.after.health_ok, true);
  assert.equal(r.after.identity_verified, true);
  assert.equal(r.after.health_pid, r.start.pid);
  assert.equal(r.after.version, '9.9.9-test');
  assert.ok(alive(r.start.pid));
  // The receipt is durable and says who asked.
  const saved = R.readReceipts(dir, 5);
  assert.equal(saved.at(-1).receipt_id, r.receipt_id);
  assert.equal(saved.at(-1).caller, 'test');
  // Status agrees, and the reviver keeps no secret of Munder's in its answer.
  const s = await reviver.status();
  assert.equal(s.healthy, true);
  assert.equal(s.last.verdict, 'healthy');
  const token = JSON.parse(fs.readFileSync(path.join(ud, 'munder-control.json'), 'utf8')).token;
  assert.ok(!JSON.stringify(s).includes(token), 'the control token never leaves the machine');
  assert.ok(!fs.readFileSync(R.files(dir).receipts, 'utf8').includes(token), 'nor lands in a receipt');
});

test('start while healthy is a NO-OP: same pid, no twin', async (t) => {
  const { reviver, config } = setup(t);
  const first = track(await reviver.start('test'));
  assert.equal(first.verdict, 'healthy');
  const again = await reviver.start('test');
  assert.equal(again.verdict, 'noop_healthy');
  assert.equal(again.ok, true);
  assert.equal(again.start, undefined, 'nothing spawned');
  assert.deepEqual(R.candidates(R.systemProcs(), config.target).map((p) => p.pid), [first.start.pid]);
});

const pidIn = (ud, f) => Number(fs.readFileSync(path.join(ud, f), 'utf8'));

test('restart: old target verified → old process and helpers gone → new one healthy with the right identity', async (t) => {
  const { reviver, ud } = setup(t);
  const first = track(await reviver.start('test'));
  const oldAgent = pidIn(ud, 'agent.pid');
  const oldHelper = pidIn(ud, 'helper.pid');
  const link = pidIn(ud, 'link.pid');
  assert.ok(alive(oldAgent) && alive(oldHelper) && alive(link));
  const r = track(await reviver.restart('test'));
  assert.equal(r.verdict, 'healthy', r.reason);
  assert.equal(r.before.state, 'healthy');
  assert.equal(r.stop.verified_target, true);
  assert.equal(r.stop.verified_by, 'salud+pid+oficina');
  assert.equal(r.stop.pid, first.start.pid);
  assert.deepEqual(r.stop.tree, [first.start.pid, oldHelper], 'the main process and its Chromium helper, nothing else');
  assert.equal(r.stop.exit_confirmed, true);
  assert.notEqual(r.start.pid, first.start.pid);
  assert.equal(r.after.identity_verified, true);
  await until(() => !alive(first.start.pid) && !alive(oldHelper), 5000, 'old process and helper to be gone');
  assert.ok(alive(link), 'the detached Link daemon outlives Munder, as designed');
  if (r.stop.graceful) await until(() => !alive(oldAgent), 5000, 'the app closed its own agent');
  // Forced: the agent is either listed as left running, or already gone with its
  // parent (Windows puts a node child in the parent's kill-on-close job). Never guessed at.
  else assert.ok(r.stop.left_running.some((p) => p.pid === oldAgent) || !alive(oldAgent), 'a forced stop lists what it left');
});

test('restart never touches an unrelated opencode, nor another Munder with another userData', async (t) => {
  const { reviver, script, root } = setup(t);
  track(await reviver.start('test'));
  const human = bystander(['-e', 'setInterval(() => {}, 1000)', 'opencode', '--session', 'human']);
  const otherUd = path.join(root, 'other-userData');
  fs.mkdirSync(otherUd);
  fs.writeFileSync(path.join(otherUd, 'office'), OTHER);
  const otherMunder = bystander([script, `--user-data-dir=${otherUd}`]);
  await until(() => fs.existsSync(path.join(otherUd, 'munder-control.json')), 5000, 'other munder');
  const r = track(await reviver.restart('test'));
  assert.equal(r.verdict, 'healthy', r.reason);
  assert.ok(!r.stop.tree.includes(human) && !r.stop.tree.includes(otherMunder));
  assert.ok(alive(human), 'the human opencode survived');
  assert.ok(alive(otherMunder), 'the other Munder survived');
});

test('ambiguous target (two processes of the configured instance): restart fails closed, kills nothing', async (t) => {
  const { reviver, config } = setup(t);
  const a = bystander(config.target.args);
  const b = bystander(config.target.args);
  await until(() => R.candidates(R.systemProcs(), config.target).length === 2, 5000, 'two candidates');
  const r = await reviver.restart('test');
  assert.equal(r.verdict, 'failed');
  assert.match(r.reason, /no mato a ninguno/);
  assert.equal(r.start, undefined);
  assert.ok(alive(a) && alive(b), 'both still alive');
  const s = await reviver.start('test');
  assert.equal(s.verdict, 'failed', 'start does not add a third');
  assert.equal(s.start, undefined);
});

test('wrong identity: something healthy answers for another office → failed, never "healthy"', async (t) => {
  const { reviver } = setup(t, { office: OTHER });
  const r = track(await reviver.start('test'));
  assert.equal(r.verdict, 'failed');
  assert.equal(r.ok, false);
  assert.match(r.reason, /otra oficina/);
  assert.equal(r.after.health_ok, true, 'it did answer');
  assert.equal(r.after.identity_verified, false);
  // …and restart refuses to kill what it cannot prove is ours.
  const again = await reviver.restart('test');
  assert.equal(again.verdict, 'failed');
  assert.ok(alive(r.start.pid));
});

test('failed launch: missing target → explicit failure, one attempt, evidence', async (t) => {
  const { reviver, dir } = setup(t, { exe: path.join(os.tmpdir(), 'no-such-munder', 'munder.exe') });
  const r = await reviver.start('test');
  assert.equal(r.verdict, 'failed');
  assert.match(r.reason, /no existe el ejecutable/);
  assert.equal(R.readReceipts(dir, 10).length, 1);
});

test('failed launch: target exits at boot → failed with exit code and log, no retry', async (t) => {
  const { reviver, dir } = setup(t, { mode: 'crash' });
  const r = await reviver.start('test');
  assert.equal(r.verdict, 'failed');
  assert.equal(r.start.spawned, true);
  assert.equal(r.start.exit.code, 1);
  assert.match(fs.readFileSync(r.start.log_file, 'utf8'), /boom/);
  assert.equal(R.readReceipts(dir, 10).length, 1);
});

test('health never answers → bounded wait, then failed (not "healthy" because a pid exists)', async (t) => {
  const { reviver, dir, config } = setup(t, { mode: 'silent' });
  config.health_timeout_ms = 2_000;
  R.saveConfig(dir, config);
  const t0 = Date.now();
  const r = track(await reviver.start('test'));
  assert.equal(r.verdict, 'failed');
  assert.ok(Date.now() - t0 < 10_000, 'bounded');
  assert.equal(r.after.state, 'starting');
  assert.ok(alive(r.start.pid), 'a pid exists, and still it is not healthy');
});

test('watchdog: unexpected death → bounded automatic restart → healthy → receipt', async (t) => {
  const { reviver, dir } = setup(t);
  const first = track(await reviver.start('test'));
  assert.equal((await reviver.tick()).why, 'healthy');
  killHard(first.start.pid);
  await until(() => !alive(first.start.pid), 5000, 'death');
  const w = await reviver.tick();
  track(w.receipt);
  assert.equal(w.acted, true);
  assert.equal(w.verdict, 'healthy');
  assert.equal(w.receipt.caller, 'watchdog');
  assert.equal(w.receipt.action, 'watchdog_start');
  assert.equal(R.readReceipts(dir, 5).at(-1).receipt_id, w.receipt.receipt_id);
});

test('intentional stop: the tree goes down and the watchdog does not resurrect it', async (t) => {
  const { reviver, ud, config } = setup(t);
  const first = track(await reviver.start('test'));
  const helper = pidIn(ud, 'helper.pid');
  const r = await reviver.stop('test');
  assert.equal(r.verdict, 'stopped', r.reason);
  assert.equal(r.stop.exit_confirmed, true);
  await until(() => !alive(first.start.pid) && !alive(helper), 5000, 'munder gone');
  for (let i = 0; i < 3; i++) assert.equal((await reviver.tick()).acted, false);
  assert.equal(R.candidates(R.systemProcs(), config.target).length, 0);
  assert.equal((await reviver.status()).desired, 'stopped');
});

test('a human closing Munder (clean quit) is left closed', async (t) => {
  const { reviver, ud } = setup(t);
  const first = track(await reviver.start('test'));
  fs.writeFileSync(path.join(ud, 'quit'), '1');
  await until(() => !alive(first.start.pid), 5000, 'clean quit');
  const w = await reviver.tick();
  assert.equal(w.acted, false);
  assert.equal(w.why, 'clean_exit');
  assert.equal((await reviver.tick()).acted, false);
});

test('someone else sending SIGTERM (start.sh --stop, logout) counts as closing it, not as a crash', { skip: process.platform === 'win32' && 'no POSIX signals on Windows' }, async (t) => {
  const { reviver, ud } = setup(t, { mode: 'raw-sigterm' });
  const first = track(await reviver.start('test'));
  process.kill(first.start.pid, 'SIGTERM');
  await until(() => !alive(first.start.pid), 5000, 'exit');
  assert.ok(fs.existsSync(path.join(ud, 'munder-control.json')), 'the file stayed, as with the real app');
  const w = await reviver.tick();
  assert.equal(w.acted, false);
  assert.equal(w.why, 'clean_exit');
});

test('restart storm: repeated launch failures → bounded retries with backoff → terminal failed state', async (t) => {
  const { dir, ud, config } = setup(t, { watchdog: { max_attempts: 3, window_ms: 60_000, backoff_ms: [1_000, 5_000] } });
  let offset = 0;
  const reviver = new R.Reviver({ dir, deps: { now: () => Date.now() + offset } });
  const first = track(await reviver.start('test'));
  fs.writeFileSync(path.join(ud, 'mode'), 'crash');
  killHard(first.start.pid);
  await until(() => !alive(first.start.pid), 5000, 'death');
  const launches = [];
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const w = await reviver.tick();
    seen.push(w.acted ? `launch:${w.verdict}` : w.why);
    if (w.acted) launches.push(w.receipt);
    offset += 1_500;
  }
  assert.equal(launches.length, 3, `exactly max_attempts launches, got ${seen.join(' ')}`);
  assert.ok(launches.every((r) => r.verdict === 'failed'));
  assert.ok(seen.includes('backoff'), `waited between attempts: ${seen.join(' ')}`);
  assert.ok(seen.includes('gave_up'));
  assert.equal(seen.at(-1), 'failed', 'terminal until an operator acts');
  assert.equal((await reviver.status()).watchdog.state, 'failed');
  // An operator start clears it.
  fs.writeFileSync(path.join(ud, 'mode'), 'ok');
  const r = track(await reviver.start('operator'));
  assert.equal(r.verdict, 'healthy');
  assert.equal((await reviver.status()).watchdog.state, 'armed');
  assert.equal(R.candidates(R.systemProcs(), config.target).length, 1);
});

test('one operation at a time: a second mutating call is refused as busy', async (t) => {
  const { reviver } = setup(t);
  const a = reviver.start('a');
  await assert.rejects(reviver.restart('b'), (e) => e.code === 'busy');
  track(await a);
});

// ─── the wire ────────────────────────────────────────────────────────────────
async function listen(reviver) {
  const server = R.createReviverServer({ reviver });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, address: `127.0.0.1:${server.address().port}` };
}

test('wire: signed calls work; unsigned, replayed, wrong-office, unknown-client and swapped-op requests are refused', async (t) => {
  const { reviver, dir } = setup(t);
  const { server, address } = await listen(reviver);
  t.after(() => server.close());
  const cred = R.localCredential(dir);
  const s = await R.call(cred, 'status', { address });
  assert.equal(s.munder.state, 'down');

  const post = (op, body, sig) => fetch(`http://${address}/reviver/v1/${op}`, { method: 'POST', headers: sig ? { 'x-reviver-sig': sig } : {}, body });
  const body = (over = {}) => JSON.stringify({ v: 1, op: 'start', reviver_id: cred.reviver.reviver_id, office_id: OFFICE, client: cred.client_id, ts: Date.now(), nonce: require('node:crypto').randomBytes(18).toString('base64url'), ...over });

  assert.equal((await post('start', body())).status, 401, 'unsigned');
  const raw = body();
  const sig = R.sign(cred.key, 'req', raw);
  assert.equal((await post('status', raw, sig)).status, 401, 'signed for start, sent to status');
  const other = R.newKeyPair();
  const raw2 = body({ client: R.idOf(other.x) });
  assert.equal((await post('start', raw2, R.sign(other, 'req', raw2))).status, 401, 'unknown client');
  const raw3 = body({ office_id: OTHER });
  assert.equal((await post('start', raw3, R.sign(cred.key, 'req', raw3))).status, 401, 'another office');
  const raw4 = body({ ts: Date.now() - 5 * 60_000 });
  assert.equal((await post('start', raw4, R.sign(cred.key, 'req', raw4))).status, 401, 'stale');
  const rawStatus = body({ op: 'status' });
  const sigStatus = R.sign(cred.key, 'req', rawStatus);
  assert.equal((await post('status', rawStatus, sigStatus)).status, 200);
  const replay = await post('status', rawStatus, sigStatus);
  assert.equal(replay.status, 401, 'replay');
  assert.equal((await replay.json()).error, 'replay');
  assert.equal((await fetch(`http://${address}/reviver/v1/exec`, { method: 'POST', body: '{}' })).status, 404, 'no exec, ever');
  // None of those reached Munder.
  assert.equal(R.readReceipts(dir, 10).length, 0);
});

test('wire: the client rejects an answer not signed by the pinned reviver', async (t) => {
  const { reviver, dir } = setup(t);
  const { server, address } = await listen(reviver);
  t.after(() => server.close());
  const cred = R.localCredential(dir);
  const impostor = { ...cred, reviver: { ...cred.reviver, x: R.newKeyPair().x } };
  await assert.rejects(R.call(impostor, 'status', { address }), (e) => e.code === 'bad_reply_signature');
  await assert.rejects(R.call(cred, 'exec', { address }), (e) => e.code === 'bad_op');
});

test('clients: a new credential works from "another machine", and revoking it locks it out', async (t) => {
  const { reviver, dir } = setup(t);
  const { server, address } = await listen(reviver);
  t.after(() => server.close());
  const cred = R.newClientCredential(dir, 'chatgpt-mcp', address);
  assert.ok(!JSON.stringify(R.loadClients(dir)).includes(cred.key.d), 'the private half is not kept here');
  assert.equal((await R.call(cred, 'status')).office.expected, OFFICE);
  R.revokeClient(dir, 'chatgpt-mcp');
  await assert.rejects(R.call(cred, 'status'), (e) => e.code === 'unknown_client');
});

test('Windows command lines split like CommandLineToArgvW, so a sibling checkout never matches', () => {
  assert.deepEqual(R.splitWindowsCmd('"C:\\ISyCo Git\\munder-difflin\\node_modules\\electron\\dist\\electron.exe" "C:\\ISyCo Git\\munder-difflin"'),
    ['C:\\ISyCo Git\\munder-difflin\\node_modules\\electron\\dist\\electron.exe', 'C:\\ISyCo Git\\munder-difflin']);
  assert.deepEqual(R.splitWindowsCmd('a\\\\"b c" d\\"e  "" x\\y'), ['a\\b c', 'd"e', '', 'x\\y']);
  const target = { exe: process.execPath, args: ['C:\\x\\munder-difflin'] };
  const row = (cmd) => ({ pid: 1, ppid: 0, start: '1', exe: process.execPath, argv: R.splitWindowsCmd(cmd), cmd });
  assert.equal(R.candidates([row('electron.exe C:\\x\\munder-difflin2')], target).length, 0);
  assert.equal(R.candidates([row('electron.exe "C:\\x\\munder-difflin"')], target).length, 1);
  assert.equal(R.candidates([row('electron.exe --type=gpu-process "C:\\x\\munder-difflin"')], target).length, 0, 'a helper is never the main');
});

test('wire: a client id like __proto__ is just unknown', () => {
  const identity = R.loadIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'reviver-id-')));
  const k = R.newKeyPair();
  const raw = JSON.stringify({ v: 1, op: 'status', reviver_id: identity.reviver_id, office_id: OFFICE, client: '__proto__', ts: Date.now(), nonce: 'abcdefghijklmnopqrstuvwx' });
  assert.throws(() => R.checkRequest({ identity, config: { office_id: OFFICE }, clients: {}, seen: new Map(), bootAt: 0 }, 'status', raw, R.sign(k, 'req', raw)), (e) => e.code === 'unknown_client');
});

test('config: the launch target is validated and only comes from config.json', () => {
  assert.deepEqual(R.validateConfig({ office_id: OFFICE, target: { exe: '/x', args: [], cwd: '/' }, user_data: '/u', bind: '127.0.0.1', port: 1 }), []);
  const bad = R.validateConfig({ office_id: 'nope', target: { exe: 'relative', args: 'a b', cwd: 'x' }, user_data: 'u', bind: '', port: -1 });
  assert.equal(bad.length, 7);
});

test('service files: systemd keeps Munder alive across reviver restarts; Windows task restarts the reviver', () => {
  const unit = CLI.systemdUnit();
  assert.match(unit, /ExecStart=".+" ".+reviver\.cjs" servir/);
  assert.match(unit, /KillMode=process/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
  const xml = CLI.windowsTaskXml('C:\\x\\reviver-launch.vbs');
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /&quot;C:\\x\\reviver-launch\.vbs&quot;/);
  const vbs = CLI.windowsLauncherVbs();
  assert.match(vbs, /sh\.Run\(.+servir", 0, True\)/);
  assert.match(vbs, /WScript\.Quit rc/);
});

// ─── acceptance: the daemon as its own process ───────────────────────────────
test('e2e: the daemon outlives Munder and revives it through the CLI', { timeout: 120_000 }, async (t) => {
  const { dir, config } = setup(t);
  config.port = 40_000 + Math.floor(Math.random() * 5_000);
  config.watchdog.enabled = false; // this test drives recovery by hand; the watchdog has its own tests
  R.saveConfig(dir, config);
  R.localCredential(dir);
  const env = { ...process.env, MUNDER_REVIVER_DIR: dir };
  const daemon = spawn(process.execPath, [path.join(__dirname, 'reviver.cjs'), 'servir'], { env, stdio: 'ignore' });
  spawned.add(daemon.pid);
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'reviver.cjs'), ...args], { env, encoding: 'utf8', timeout: 90_000 });
  await until(() => cli('status').status === 3, 15_000, 'daemon up');

  let r = cli('status');
  assert.match(r.stdout, /munder: +down/);
  r = cli('start', '--json');
  assert.equal(r.status, 0, r.stderr);
  const started = JSON.parse(r.stdout);
  spawned.add(started.start.pid);
  assert.equal(started.verdict, 'healthy');

  r = cli('start', '--json');
  assert.equal(JSON.parse(r.stdout).verdict, 'noop_healthy');

  killHard(started.start.pid);
  await until(() => !alive(started.start.pid), 5000, 'munder dead');
  assert.ok(alive(daemon.pid), 'killing Munder did not kill the reviver');
  r = cli('status', '--json');
  const down = JSON.parse(r.stdout);
  assert.equal(down.healthy, false);
  assert.equal(down.munder.running, false);

  r = cli('restart', '--json');
  assert.equal(r.status, 0, r.stderr);
  const back = JSON.parse(r.stdout);
  spawned.add(back.start.pid);
  assert.equal(back.verdict, 'healthy');
  assert.equal(back.after.identity_verified, true);

  r = cli('recibos');
  assert.match(r.stdout, /restart +healthy/);
  daemon.kill();
});

// ─── the MCP adapter (the ChatGPT boundary) ──────────────────────────────────
const MCP = require('./reviver-mcp.cjs');

test('MCP adapter: three tools, the only input is a machine from the targets file, and it reaches the real reviver', async (t) => {
  const { reviver, dir, root } = setup(t);
  const { server, address } = await listen(reviver);
  t.after(() => server.close());
  const cred = R.newClientCredential(dir, 'chatgpt', address);
  fs.writeFileSync(path.join(root, 'xeon.json'), JSON.stringify(cred));
  fs.writeFileSync(path.join(root, 'targets.json'), JSON.stringify({ machines: { xeon: { credential: 'xeon.json' } } }));
  const machines = MCP.loadTargets(path.join(root, 'targets.json'));

  const init = await MCP.handle({ id: 1, method: 'initialize', params: {} }, machines);
  assert.equal(init.serverInfo.name, 'munder-reviver');
  const { tools } = await MCP.handle({ id: 2, method: 'tools/list' }, machines);
  assert.deepEqual(tools.map((x) => x.name), ['munder_status', 'munder_start', 'munder_restart']);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['machine']);
    assert.deepEqual(tool.inputSchema.properties.machine.enum, ['xeon']);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const st = await MCP.handle({ id: 3, method: 'tools/call', params: { name: 'munder_status', arguments: { machine: 'xeon' } } }, machines);
  assert.equal(st.isError, false);
  assert.match(st.content[0].text, /^xeon: Munder DOWN/);
  const up = await MCP.handle({ id: 4, method: 'tools/call', params: { name: 'munder_start', arguments: { machine: 'xeon' } } }, machines);
  track(up.structuredContent);
  assert.equal(up.isError, false, up.content[0].text);
  assert.match(up.content[0].text, /start → healthy/);
  assert.match(up.structuredContent.caller, /^chatgpt /, 'the receipt names the authenticated client');

  await assert.rejects(MCP.handle({ id: 5, method: 'tools/call', params: { name: 'munder_start', arguments: { machine: 'xeon', exe: '/bin/sh' } } }, machines), /unexpected arguments: exe/);
  await assert.rejects(MCP.handle({ id: 6, method: 'tools/call', params: { name: 'munder_start', arguments: { machine: '__proto__' } } }, machines), /unknown machine/);
  await assert.rejects(MCP.handle({ id: 7, method: 'tools/call', params: { name: 'munder_exec', arguments: { machine: 'xeon' } } }, machines), /unknown tool/);
});

test('MCP adapter: the same network gate as munder-chatgpt-link (a public address is refused before any call)', async () => {
  let called = false;
  const machines = { xeon: { cred: { reviver: {} }, address: '8.8.8.8:47833' } };
  const r = await MCP.handle({ id: 1, method: 'tools/call', params: { name: 'munder_restart', arguments: { machine: 'xeon' } } }, machines,
    async () => { called = true; });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not an allowed route \(public/);
  assert.equal(called, false);
});

test('MCP adapter: an unreachable reviver is an explained tool error, not a crash', async () => {
  const machines = { xeon: { cred: { reviver: {} }, address: '127.0.0.1:1' } };
  const r = await MCP.handle({ id: 1, method: 'tools/call', params: { name: 'munder_status', arguments: { machine: 'xeon' } } }, machines,
    async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not reach its reviver \(ECONNREFUSED\).*Wake-on-LAN/);
});

test('MCP adapter over real stdio: initialize, list, call', { timeout: 60_000 }, async (t) => {
  const { reviver, dir, root } = setup(t);
  const { server, address } = await listen(reviver);
  t.after(() => server.close());
  fs.writeFileSync(path.join(root, 'victus.json'), JSON.stringify(R.newClientCredential(dir, 'mcp', address)));
  fs.writeFileSync(path.join(root, 'targets.json'), JSON.stringify({ machines: { victus: { credential: 'victus.json' } } }));
  const p = spawn(process.execPath, [path.join(__dirname, 'reviver-mcp.cjs')], { env: { ...process.env, MUNDER_REVIVER_TARGETS: path.join(root, 'targets.json') } });
  t.after(() => p.kill());
  const replies = new Map();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); }
  });
  const rpc = async (id, method, params) => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    await until(() => replies.has(id), 20_000, `reply ${id}`);
    return replies.get(id);
  };
  assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result.serverInfo.name, 'munder-reviver');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc(2, 'tools/list', {})).result.tools.length, 3);
  const st = await rpc(3, 'tools/call', { name: 'munder_status', arguments: { machine: 'victus' } });
  assert.match(st.result.content[0].text, /^victus: Munder DOWN/);
  assert.equal((await rpc(4, 'tools/call', { name: 'munder_status', arguments: { machine: 'nope' } })).error.code, -32602);
});
