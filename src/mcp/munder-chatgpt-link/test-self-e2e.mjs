// End to end, the way ChatGPT meets it: a real MCP client over stdio against
// server.mjs running in office A, with office B paired over a real Munder Link.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const L = require('../../../tools/munder/lib-link.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));

function office(name, workers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-e2e-${name}-`));
  const hive = path.join(root, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const agents = { god: { status: 'idle' } };
  for (let i = 0; i < workers; i++) agents[`w${i}`] = { status: 'idle' };
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents }));
  const dir = path.join(root, 'state');
  return { dir, hive, identity: L.loadIdentity(dir, `michael-${name}`) };
}

const parse = (r) => JSON.parse(r.content[0].text);

test('self and peers are told apart through the MCP tools', async (t) => {
  const a = office('victus', 1);
  const b = office('windows', 3);
  const { server } = L.createLinkServer({ dir: b.dir, hiveRoot: b.hive, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { peer, code } = await L.requestPair(`127.0.0.1:${server.address().port}`, { dir: a.dir });
  L.trustPeer(peer, a.dir);
  L.acceptPending(code, b.dir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'server.mjs')],
    env: { ...process.env, MUNDER_LINK_DIR: a.dir, MUNDER_LINK_HIVE: a.hive },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());

  const peers = parse(await client.callTool({ name: 'munder_link_peers', arguments: {} }));
  assert.equal(peers.self.name, 'michael-victus');
  assert.deepEqual(peers.peers.map((p) => p.name), ['michael-windows']);

  const self = parse(await client.callTool({ name: 'munder_office_status', arguments: { office: 'self' } }));
  assert.equal(self.self, true);
  assert.equal(self.office.name, 'michael-victus');
  assert.equal(self.capacity.workers_total, 1);
  assert.equal(self.hive, a.hive);

  const byName = parse(await client.callTool({ name: 'munder_office_status', arguments: { office: 'victus' } }));
  assert.equal(byName.self, true, 'its own short name is self too');

  const remote = parse(await client.callTool({ name: 'munder_office_status', arguments: { office: 'windows' } }));
  assert.equal(remote.result.name, 'michael-windows');
  assert.equal(remote.result.capacity.workers_total, 3, 'the peer answers with ITS numbers over Link');

  const refused = await client.callTool({ name: 'munder_compose_submit', arguments: { office: 'self', compose: 'hola' } });
  assert.equal(refused.isError, true);
  assert.equal(parse(refused).error, 'self_not_a_peer');
});
