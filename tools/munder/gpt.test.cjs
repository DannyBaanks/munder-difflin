'use strict';
// node --test tools/munder/gpt.test.cjs
//
// Munder GPT against real HTTP: a live gateway, the real OAuth endpoints, a
// real hive on disk, and two real Munder Link offices. The ChatGPT side is
// played by plain fetch() doing exactly what an MCP OAuth client does
// (dynamic registration, PKCE S256, authorize, token, Bearer on /mcp). The
// operator's approval is `munder gpt aprobar` (G.approve), nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-gpt-'));
process.env.MUNDER_GPT_DIR = path.join(root, 'gpt');
process.env.MUNDER_LINK_DIR = path.join(root, 'link-a');
process.env.MUNDER_LINK_HIVE = path.join(root, 'hive-a');
process.env.MUNDER_USER_DATA = path.join(root, 'userData');
process.env.MUNDER_REVIVER_DIR = path.join(root, 'reviver');
fs.mkdirSync(process.env.MUNDER_LINK_HIVE, { recursive: true });
fs.mkdirSync(process.env.MUNDER_USER_DATA, { recursive: true });

const L = require('./lib-link.cjs');
const G = require('./lib-gpt.cjs');

const HIVE = process.env.MUNDER_LINK_HIVE;
const DIR = process.env.MUNDER_GPT_DIR;
L.loadIdentity(undefined, 'michael-victus');
fs.writeFileSync(path.join(HIVE, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { name: 'Michael', status: 'working' }, jim: { name: 'Jim', status: 'idle' } } }));
fs.writeFileSync(path.join(HIVE, 'tasks.json'), JSON.stringify({ tasks: [
  { id: 't-q', title: 'Elegir base de datos', status: 'blocked', createdAt: '2026-09-25T00:00:00Z', humanQA: [{ q: '¿Postgres o SQLite?', askedAt: '2026-09-25T00:00:00Z' }] },
  { id: 't-private', title: 'Nómina de marzo (privado)', status: 'doing', createdAt: '2026-09-24T00:00:00Z' },
] }));
fs.mkdirSync(path.join(HIVE, 'agents', 'jim', 'inbox'), { recursive: true });
fs.writeFileSync(path.join(HIVE, 'agents', 'jim', 'inbox', 'secret-1.json'), JSON.stringify({ id: 'secret-1', from: 'god', to: 'jim', subject: 'contraseña del NAS', body: 'no es para GPT' }));

let server;
let base;
const leaked = new Set(); // every raw token/code the client ever saw: none may land on disk

test.before(async () => {
  server = G.createGatewayServer({ dir: DIR });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  G.saveConfig(DIR, { enabled: true, public_url: base, port: server.address().port, profile: 'full' });
  G.ensureInbox();
});
test.after(() => { server.close(); });

// ─── the ChatGPT side ────────────────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64url');

async function register(name = 'ChatGPT', redirect = 'https://chatgpt.com/connector_platform_oauth_redirect') {
  const r = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(r.status, 201);
  return { ...(await r.json()), redirect };
}

async function authorize(client, { scope, verifier = b64u(crypto.randomBytes(32)), approve = true } = {}) {
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', resource: `${base}/mcp`, ...(scope ? { scope } : {}) });
  const page = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
  if (page.status === 302) return { redirect: page.headers.get('location') };
  assert.equal(page.status, 200);
  const html = await page.text();
  const rid = html.match(/const rid=("[^"]+")/)[1];
  const code6 = html.match(/munder gpt aprobar (\d{6})/)[1];
  // Before the operator acts, the page can only wait.
  assert.equal((await (await fetch(`${base}/authorize/status?request=${encodeURIComponent(JSON.parse(rid))}`)).json()).status, 'pending');
  if (approve === 'skip') return { code6 };
  const decision = G.approve(DIR, code6, approve ? 'approve' : 'deny');
  const st = await (await fetch(`${base}/authorize/status?request=${encodeURIComponent(JSON.parse(rid))}`)).json();
  const u = new URL(st.redirect);
  assert.equal(u.searchParams.get('state'), 'st-1');
  return { decision, code: u.searchParams.get('code'), error: u.searchParams.get('error'), verifier };
}

async function tokenCall(body) {
  const r = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json();
  for (const k of ['access_token', 'refresh_token']) if (j[k]) leaked.add(j[k]);
  return { status: r.status, body: j };
}

const clients = new Map();
async function connect(opts = {}) {
  const key = opts.name || 'ChatGPT';
  if (!clients.has(key)) clients.set(key, await register(key));
  const client = clients.get(key);
  const a = await authorize(client, opts);
  leaked.add(a.code);
  const t = await tokenCall({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, client_id: client.client_id, redirect_uri: client.redirect, resource: `${base}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { client, grant_id: a.decision.grant_id, ...t.body };
}

let rpcId = 0;
async function mcp(tok, method, params) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}
const call = async (tok, name, args = {}) => {
  const r = await mcp(tok, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
};

// ─── discovery and inventory ─────────────────────────────────────────────────
test('munder gpt is discoverable from the munder CLI', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'munder'), 'gpt', 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /munder gpt perfil lectura\|operador\|full/);
  const help = spawnSync(process.execPath, [path.join(__dirname, 'munder'), 'help'], { encoding: 'utf8' });
  assert.match(help.stdout, /gpt …/);
});

test('inventory: every operation of the real surfaces is classified, and every exposed one is a real tool', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const remote = src('lib-remote.cjs');
  const dispatch = remote.slice(remote.indexOf('async function dispatch'), remote.indexOf('async function handle'));
  const remoteOps = [...dispatch.matchAll(/case '(\w+)':/g)].map((m) => m[1]);
  const link = src('lib-link.cjs');
  const at = link.indexOf("case 'status': {");
  const linkOps = [...link.slice(at, at + 1500).matchAll(/case '(\w+)':/g)].map((m) => m[1]);
  const cc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'controlChannel.ts'), 'utf8');
  const routes = [...cc.matchAll(/req\.method === '(\w+)' && path === '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  if (/req\.method === 'DELETE' && path\.startsWith\('\/sesion\/agentes\/'\)/.test(cc)) routes.push('DELETE /sesion/agentes/');
  const reviverOps = require('./lib-reviver.cjs').OPS;
  assert.ok(remoteOps.length >= 6 && linkOps.length >= 6 && routes.length >= 6, 'the parsers found the surfaces');
  const tools = new Set(G.CAPABILITIES.map((c) => c.name));
  for (const [surface, ops] of [['remote', remoteOps], ['link', linkOps], ['control', routes], ['reviver', reviverOps]]) {
    for (const op of ops) {
      const c = G.INVENTORY[surface][op];
      assert.ok(c, `${surface}.${op} is neither exposed nor excluded in INVENTORY: classify it`);
      assert.ok(c.exposed ? tools.has(c.exposed) : typeof c.excluded === 'string', `${surface}.${op}: ${JSON.stringify(c)}`);
    }
  }
  assert.deepEqual(G.describeProfile('full').tools.map((t) => t.name), G.CAPABILITIES.map((c) => c.name), 'Full = every capability');
  for (const c of G.CAPABILITIES) assert.ok(G.SCOPES[c.scope], `${c.name} has a known scope`);
});

test('profiles nest: lectura ⊂ operador ⊂ full', () => {
  const n = (p) => G.describeProfile(p).tools.map((t) => t.name);
  assert.ok(n('lectura').every((t) => n('operador').includes(t)));
  assert.ok(n('operador').every((t) => n('full').includes(t)));
  assert.ok(n('lectura').every((t) => !G.CAPABILITIES.find((c) => c.name === t).mutating), 'lectura never mutates');
});

// ─── OAuth ───────────────────────────────────────────────────────────────────
test('the URL alone grants nothing: /mcp without a token is 401 with the OAuth discovery pointer', async () => {
  const r = await mcp(null, 'tools/list');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), new RegExp(`^Bearer .*resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
  for (const bad of ['Bearer nope', 'Bearer mga_forged', 'Basic dXNlcjpwYXNz']) {
    const x = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: bad, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(x.status, 401, bad);
  }
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/register`);
});

test('full: operator approval → token → the tool list is exactly the Full grant', async () => {
  const s = await connect();
  assert.equal(s.token_type, 'Bearer');
  assert.ok(s.expires_in <= 3600);
  const init = await mcp(s.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.serverInfo.name, 'munder-gpt');
  const list = await mcp(s.access_token, 'tools/list');
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), G.capabilitiesFor(G.PROFILES.full).map((c) => c.name).sort());
  const ov = await call(s.access_token, 'office_overview');
  assert.equal(ov.isError, false);
  assert.equal(ov.structuredContent.office.name, 'michael-victus');
});

test('OAuth rejects: wrong PKCE verifier, reused code, unregistered redirect, plain PKCE, denied request', async () => {
  const c = await register();
  const a = await authorize(c);
  leaked.add(a.code);
  const bad = await tokenCall({ grant_type: 'authorization_code', code: a.code, code_verifier: 'x'.repeat(43), client_id: c.client_id });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_grant');
  const reuse = await tokenCall({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, client_id: c.client_id });
  assert.equal(reuse.body.error, 'invalid_grant', 'a code is single use, even after a failed attempt');

  const evil = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  assert.equal(evil.status, 400, 'never redirects to an unregistered URI');
  const plain = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: c.redirect, code_challenge: 'abc', code_challenge_method: 'plain', state: 's' })}`, { redirect: 'manual' });
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
  const nope = await register('Intruso');
  const d = await authorize(nope, { approve: false });
  assert.equal(d.error, 'access_denied');
  const reg = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(reg.status, 400, 'plain http redirects only for localhost');
});

test('a pending request cannot be approved from the web: the code only works in the operator terminal', async () => {
  const c = await register('Alguien');
  const { code6 } = await authorize(c, { approve: 'skip' });
  for (const [m, p] of [['POST', '/authorize'], ['POST', `/approve?code=${code6}`], ['GET', `/aprobar/${code6}`]]) {
    const r = await fetch(`${base}${p}`, { method: m, redirect: 'manual' });
    assert.ok([404, 405].includes(r.status), `${m} ${p} → ${r.status}`);
  }
  assert.ok(G.pendingRequests(DIR).some((r) => r.approval_code === code6), 'still pending');
  G.approve(DIR, code6, 'deny');
});

// ─── scopes ──────────────────────────────────────────────────────────────────
test('lectura: read works, every mutation is refused and audited, nothing is written', async () => {
  const s = await connect({ scope: 'munder.read' });
  const tools = (await mcp(s.access_token, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.ok(tools.includes('office_overview') && !tools.includes('michael_message'));
  const godInbox = path.join(HIVE, 'agents', 'god', 'inbox');
  const before = fs.existsSync(godInbox) ? fs.readdirSync(godInbox).length : 0;
  const r = await call(s.access_token, 'michael_message', { text: 'hola' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /requiere munder\.operate/);
  assert.equal(fs.existsSync(godInbox) ? fs.readdirSync(godInbox).length : 0, before, 'no message written');
  assert.ok(G.readAudit(DIR, 50).some((e) => e.event === 'tool_denied' && e.tool === 'michael_message' && e.grant_id === s.grant_id));
  const extra = await mcp(s.access_token, 'tools/call', { name: 'office_overview', arguments: { path: '/etc/passwd' } });
  assert.equal(extra.body.error.code, -32602, 'unknown arguments are refused');
});

test('lowering the profile takes effect on live grants at once; raising it never exceeds what the grant asked for', async () => {
  const s = await connect();
  G.saveConfig(DIR, { profile: 'lectura' });
  try {
    const tools = (await mcp(s.access_token, 'tools/list')).body.result.tools;
    assert.ok(tools.every((t) => G.CAPABILITIES.find((c) => c.name === t.name).scope === 'munder.read'));
    assert.equal((await call(s.access_token, 'agent_fire', { agent_id: 'jim' })).isError, true);
  } finally {
    G.saveConfig(DIR, { profile: 'full' });
  }
  const r = await connect({ scope: 'munder.read' });
  assert.equal((await mcp(r.access_token, 'tools/list')).body.result.tools.some((t) => t.name === 'agent_hire'), false, 'a read grant stays read under Full');
});

// ─── the GPT principal and its inbox ─────────────────────────────────────────
test('operator actions are attributed to principal gpt, with a receipt, in the hive log and the audit', async () => {
  const s = await connect({ scope: 'munder.read munder.operate' });
  const r = await call(s.access_token, 'michael_message', { text: 'Revisa el PR 21 cuando puedas' });
  assert.equal(r.isError, false);
  const { message_id, receipt } = r.structuredContent;
  const msg = JSON.parse(fs.readFileSync(path.join(HIVE, 'agents', 'god', 'inbox', `${message_id}.json`), 'utf8'));
  assert.equal(msg.from, 'gpt');
  assert.equal(msg.to, 'god');
  assert.equal(receipt.principal, 'gpt');
  assert.equal(receipt.grant_id, s.grant_id);
  const log = fs.readFileSync(path.join(HIVE, 'log.jsonl'), 'utf8');
  assert.match(log, new RegExp(`"event":"gpt_message","principal":"gpt","grant_id":"${s.grant_id}","message_id":"${message_id}"`));
  assert.ok(G.readAudit(DIR, 100).some((e) => e.event === 'tool_call' && e.tool === 'michael_message' && e.receipt_id === receipt.id && e.grant_id === s.grant_id));

  const qa = await call(s.access_token, 'question_answer', { task_id: 't-q', q: '¿Postgres o SQLite?', text: 'SQLite por ahora' });
  assert.equal(qa.isError, false);
  const t = JSON.parse(fs.readFileSync(path.join(HIVE, 'tasks.json'), 'utf8')).tasks.find((x) => x.id === 't-q');
  assert.equal(t.humanQA[0].a, 'SQLite por ahora');
  assert.equal(t.humanQA[0].answeredBy, 'gpt');
});

test('"¿Ya me contestó Michael?": a Michael→gpt message is found without any id, read, answered in-thread and marked read', async () => {
  const s = await connect({ scope: 'munder.read munder.operate' });
  // What the hive router does with {"to":"gpt"} (test/gpt-inbox-routing.test.cjs covers the router itself).
  const m = { id: '2026-09-25T20-00-00Z-abcd1234', conversation: 'gpt-xyz', in_reply_to: null, from: 'god', to: 'gpt', act: 'inform', subject: 'PR 21 revisado', body: 'Todo verde. ¿Lo mergeo?', created_at: '2026-09-25T20:00:00Z' };
  fs.writeFileSync(path.join(G.gptInbox(), `${m.id}.json`), JSON.stringify(m));
  const inbox = await call(s.access_token, 'gpt_inbox');
  const hit = inbox.structuredContent.messages.find((x) => x.subject === 'PR 21 revisado');
  assert.ok(hit, 'discovered with no id given');
  assert.equal(hit.from, 'god');
  const full = await call(s.access_token, 'gpt_inbox_read', { message_id: hit.id });
  assert.equal(full.structuredContent.message.body, 'Todo verde. ¿Lo mergeo?');
  const rep = await call(s.access_token, 'gpt_inbox_reply', { message_id: hit.id, text: 'Sí, mergéalo' });
  const back = JSON.parse(fs.readFileSync(path.join(HIVE, 'agents', 'god', 'inbox', `${rep.structuredContent.message_id}.json`), 'utf8'));
  assert.equal(back.in_reply_to, m.id);
  assert.equal(back.conversation, 'gpt-xyz');
  assert.equal(back.from, 'gpt');
  await call(s.access_token, 'gpt_inbox_mark_read', { message_id: hit.id });
  assert.equal((await call(s.access_token, 'gpt_inbox')).structuredContent.messages.some((x) => x.id === hit.id), false);
  assert.ok((await call(s.access_token, 'gpt_inbox', { include_read: true })).structuredContent.messages.some((x) => x.id === hit.id && x.read));
});

test('the GPT inbox never exposes other agents\' mail, nor paths outside it', async () => {
  const s = await connect();
  const everything = JSON.stringify((await call(s.access_token, 'gpt_inbox', { include_read: true })).structuredContent);
  assert.ok(!everything.includes('contraseña del NAS'));
  for (const id of ['../../agents/jim/inbox/secret-1', '..%2f..%2fagents%2fjim%2finbox%2fsecret-1', 'secret-1']) {
    const r = await call(s.access_token, 'gpt_inbox_read', { message_id: id });
    assert.equal(r.isError, true, id);
    assert.ok(!r.content[0].text.includes('NAS'));
  }
});

// ─── admin through the live app's control channel ────────────────────────────
test('admin: hire only with a known CLI and an existing folder; fire; both attributed to gpt', async (t) => {
  const seen = [];
  const cc = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer cc-token');
      seen.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? { ok: true, id: 'dwight' } : { ok: true }));
    });
  });
  await new Promise((r) => cc.listen(0, '127.0.0.1', r));
  t.after(() => cc.close());
  fs.writeFileSync(path.join(process.env.MUNDER_USER_DATA, 'munder-control.json'), JSON.stringify({ port: cc.address().port, token: 'cc-token' }));
  const s = await connect();
  const hired = await call(s.access_token, 'agent_hire', { name: 'Dwight', provider: 'opencode', cwd: root });
  assert.equal(hired.isError, false, hired.content[0].text);
  assert.deepEqual(seen[0], { method: 'POST', url: '/sesion/agentes', body: { name: 'Dwight', cwd: root, command: 'opencode', provider: 'opencode' } });
  assert.equal(hired.structuredContent.receipt.principal, 'gpt');
  for (const bad of [{ provider: 'bash', cwd: root }, { provider: 'claude', cwd: 'relative/dir' }, { provider: 'claude', cwd: path.join(root, 'nope') }]) {
    const r = await call(s.access_token, 'agent_hire', { name: 'X', ...bad });
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  assert.equal(seen.length, 1, 'no refused hire reached the app');
  const fired = await call(s.access_token, 'agent_fire', { agent_id: 'dwight' });
  assert.equal(fired.isError, false);
  assert.equal(seen[1].url, '/sesion/agentes/dwight');
  assert.equal((await call(s.access_token, 'agent_fire', { agent_id: '../salud' })).isError, true);
  assert.match(fs.readFileSync(path.join(HIVE, 'log.jsonl'), 'utf8'), /"event":"gpt_agent_hired","principal":"gpt"/);
});

// ─── Munder Link: Full here is not Full there ────────────────────────────────
test('Link: GPT delegates to a paired office and follows its own task; the other office\'s board stays private', async (t) => {
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-gpt-b-'));
  const B = { dir: path.join(bRoot, 'state'), hive: path.join(bRoot, 'hive') };
  fs.mkdirSync(B.hive, { recursive: true });
  fs.writeFileSync(path.join(B.hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { name: 'Michael', status: 'idle' } } }));
  fs.writeFileSync(path.join(B.hive, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't-xeon-own', title: 'Tarea local del Xeon', status: 'doing', createdAt: '2026-09-25T00:00:00Z' }] }));
  B.identity = L.loadIdentity(B.dir, 'michael-xeon');
  const A = { dir: process.env.MUNDER_LINK_DIR, hive: HIVE };
  const servers = [];
  for (const o of [A, B]) {
    const { server: s } = L.createLinkServer({ dir: o.dir, hiveRoot: o.hive, version: 'test' });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    o.address = `127.0.0.1:${s.address().port}`;
    servers.push(s);
  }
  t.after(() => servers.forEach((s) => s.close()));
  const { peer, code } = await L.requestPair(B.address, { dir: A.dir, port: Number(A.address.split(':')[1]) });
  L.trustPeer(peer, A.dir);
  L.acceptPending(code, B.dir);

  const s = await connect();
  const offices = (await call(s.access_token, 'link_offices')).structuredContent;
  assert.ok(offices.peers.some((p) => p.name === 'michael-xeon'));
  const st = await call(s.access_token, 'link_office_status', { office: 'michael-xeon' });
  assert.equal(st.isError, false, st.content[0].text);
  assert.equal(st.structuredContent.verification.verified, true);
  const d = await call(s.access_token, 'link_delegate', { office: 'michael-xeon', text: 'Corre las pruebas del módulo de pagos', title: 'Pruebas pagos' });
  assert.equal(d.isError, false, d.content[0].text);
  const own = await call(s.access_token, 'link_task_get', { office: 'michael-xeon', task_id: d.structuredContent.task_id });
  assert.equal(own.isError, false);
  assert.equal(own.structuredContent.result.title, 'Pruebas pagos');
  const other = await call(s.access_token, 'link_task_get', { office: 'michael-xeon', task_id: 't-xeon-own' });
  assert.equal(other.isError, true, 'Full on this office does not open the Xeon\'s board');
  assert.match(other.content[0].text, /no es tuya|no existe/);
  assert.match(fs.readFileSync(path.join(HIVE, 'log.jsonl'), 'utf8'), /"event":"gpt_link_delegated","principal":"gpt"/);
});

// ─── revocation, refresh, restart, secrets ───────────────────────────────────
test('refresh rotates; revocation kills access and refresh on the next request', async () => {
  const s = await connect({ name: 'ChatGPT-rev' });
  const r1 = await tokenCall({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client.client_id });
  assert.equal(r1.status, 200);
  const old = await tokenCall({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client.client_id });
  assert.equal(old.body.error, 'invalid_grant', 'a rotated refresh token is dead');
  assert.equal((await mcp(r1.body.access_token, 'tools/list')).status, 200);
  const hits = G.revoke(DIR, s.grant_id);
  assert.deepEqual(hits, [s.grant_id]);
  assert.equal((await mcp(r1.body.access_token, 'tools/list')).status, 401);
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: s.client.client_id })).body.error, 'invalid_grant');
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'gpt.cjs'), 'permisos'], { encoding: 'utf8', env: process.env });
  assert.match(cli.stdout, new RegExp(`${s.grant_id} +inactivo .*revocado`));
});

test('gateway off → nothing works; back on → the same approved grants work again (restart keeps config, not secrets)', async () => {
  const s = await connect();
  G.saveConfig(DIR, { enabled: false });
  assert.equal((await mcp(s.access_token, 'tools/list')).status, 401);
  G.saveConfig(DIR, { enabled: true });
  // A brand-new server process on the same state: an app/gateway restart.
  const again = G.createGatewayServer({ dir: DIR });
  await new Promise((r) => again.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${again.address().port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(r.status, 200);
  } finally { again.close(); }
});

test('no raw token or code is ever written to disk (grants keep hashes; audit and hive log are clean)', () => {
  assert.ok(leaked.size >= 10);
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'utf8')); } };
  walk(DIR);
  walk(HIVE);
  const blob = all.join('\n');
  for (const secret of leaked) assert.ok(!blob.includes(secret), 'a raw token/code leaked to disk');
  assert.ok(fs.readFileSync(G.files(DIR).grants, 'utf8').includes('"hash"'));
});

test('audit scrubbing: secret-looking fields never reach the audit', () => {
  G.audit(DIR, { event: 'probe', args: { access_token: 'mga_x', nested: { code: '123' }, ok: 'visible' } });
  const last = G.readAudit(DIR, 1)[0];
  assert.equal(last.args.access_token, '[REDACTED]');
  assert.equal(last.args.nested.code, '[REDACTED]');
  assert.equal(last.args.ok, 'visible');
  assert.equal(last.principal, 'gpt');
});

test('CLI lifecycle: perfil → encender (local) → estado → apagar, with the real daemon', { timeout: 60_000 }, async (t) => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-gpt-cli-'));
  const port = String(48_000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, MUNDER_GPT_DIR: path.join(envDir, 'gpt'), MUNDER_GPT_PORT: port };
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'gpt.cjs'), ...a], { env, encoding: 'utf8', timeout: 45_000 });
  t.after(() => cli('apagar'));
  let r = cli('perfil', 'operador');
  assert.notEqual(r.status, 0, 'without a TTY it asks for --si instead of assuming');
  r = cli('perfil', 'full', '--si');
  assert.equal(r.status, 0, r.stderr);
  r = cli('encender', '--transporte', 'local');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Autoridad: +FULL/);
  assert.match(r.stdout, new RegExp(`MCP Server URL: http://127\\.0\\.0\\.1:${port}/mcp`));
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.enabled, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  r = cli('estado', '--json');
  const st = JSON.parse(r.stdout);
  assert.equal(st.profile, 'full');
  assert.equal(st.gateway.running, true);
  assert.equal(st.public_reachable, true);
  r = cli('apagar');
  assert.equal(r.status, 0);
  await new Promise((res) => setTimeout(res, 500));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }), 'the daemon is gone');
  assert.equal(JSON.parse(cli('estado', '--json').stdout).profile, 'full', 'the approved configuration survives');
});
