// Conformance: the official MCP SDK client (the same OAuth + Streamable HTTP
// code path an MCP connector uses) against the Munder GPT gateway
// (tools/munder/lib-gpt.cjs). Discovery via WWW-Authenticate → protected
// resource metadata → authorization server metadata → dynamic registration →
// PKCE → operator approval (`munder gpt aprobar`) → finishAuth → tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-sdk-'));
process.env.MUNDER_GPT_DIR = path.join(root, 'gpt');
process.env.MUNDER_LINK_DIR = path.join(root, 'link');
process.env.MUNDER_LINK_HIVE = path.join(root, 'hive');
fs.mkdirSync(process.env.MUNDER_LINK_HIVE, { recursive: true });
fs.writeFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { name: 'Michael', status: 'idle' } } }));
const G = require('../../../tools/munder/lib-gpt.cjs');
const L = require('../../../tools/munder/lib-link.cjs');
L.loadIdentity(undefined, 'michael-sdk');

class Provider {
  constructor() { this.redirectUrl = 'http://localhost:8976/callback'; }
  get clientMetadata() {
    return { client_name: 'MCP SDK client (ChatGPT stand-in)', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() { return this.ci; }
  saveClientInformation(ci) { this.ci = ci; }
  tokens() { return this.t; }
  saveTokens(t) { this.t = t; }
  redirectToAuthorization(url) { this.authUrl = url; }
  saveCodeVerifier(v) { this.v = v; }
  codeVerifier() { return this.v; }
}

test('the MCP SDK client completes OAuth against munder gpt and uses the granted tools', async (t) => {
  const server = G.createGatewayServer({ dir: G.stateDir() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  G.saveConfig(G.stateDir(), { enabled: true, public_url: base, port: server.address().port, profile: 'full' });
  G.ensureInbox();

  const provider = new Provider();
  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  await assert.rejects(new Client({ name: 'sdk', version: '1' }).connect(first), UnauthorizedError, 'no authority before approval');
  assert.ok(provider.ci && provider.ci.client_id, 'dynamic client registration happened');
  assert.ok(provider.authUrl, 'the SDK was sent to /authorize');
  assert.equal(provider.authUrl.searchParams.get('code_challenge_method'), 'S256');

  // The browser page ChatGPT opens: it shows a code, the operator approves it in the terminal.
  const html = await (await fetch(provider.authUrl)).text();
  const code6 = html.match(/munder gpt aprobar (\d{6})/)[1];
  const rid = JSON.parse(html.match(/const rid=("[^"]+")/)[1]);
  G.approve(G.stateDir(), code6);
  const st = await (await fetch(`${base}/authorize/status?request=${encodeURIComponent(rid)}`)).json();
  const code = new URL(st.redirect).searchParams.get('code');
  await first.finishAuth(code);
  assert.ok(provider.t.access_token && provider.t.refresh_token);

  const client = new Client({ name: 'sdk', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), G.capabilitiesFor(G.PROFILES.full).map((c) => c.name).sort());
  const ov = await client.callTool({ name: 'office_overview', arguments: {} });
  assert.equal(ov.isError, false);
  assert.equal(ov.structuredContent.office.name, 'michael-sdk');
  const sent = await client.callTool({ name: 'michael_message', arguments: { text: 'hola Michael, soy ChatGPT' } });
  assert.equal(sent.isError, false);
  assert.equal(sent.structuredContent.receipt.principal, 'gpt');
  await client.close();

  G.revoke(G.stateDir(), 'todo');
  const after = new Client({ name: 'sdk', version: '1' });
  await assert.rejects(after.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider })), 'revoked: the SDK cannot reconnect with its old tokens');
});
