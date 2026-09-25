import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isSelfQuery, selfStatus, selfSummary, selfNotAPeer } from './self-office.mjs';

const require = createRequire(import.meta.url);
const link = require('../../../tools/munder/lib-link.cjs');

function office(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-self-${name}-`));
  const hive = path.join(root, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { status: 'idle' }, w1: { status: 'idle' }, w2: { status: 'working' } } }));
  return { dir: path.join(root, 'state'), hive, identity: link.loadIdentity(path.join(root, 'state'), `michael-${name}`) };
}

test('"self", the own name, its short form and the own id all mean this office', () => {
  const o = office('dannyisyco');
  for (const q of ['self', 'SELF', ' self ', 'michael-dannyisyco', 'dannyisyco', o.identity.office_id]) {
    assert.equal(isSelfQuery(q, o.identity), true, q);
  }
  for (const q of ['michael-danny', 'danny', '', undefined, o.identity.office_id.slice(0, 4)]) {
    assert.equal(isSelfQuery(q, o.identity), false, String(q));
  }
});

test('self summary names the office and the host, and never carries a private key', () => {
  const o = office('victus');
  const s = selfSummary(o.identity, link);
  assert.equal(s.name, 'michael-victus');
  assert.equal(s.office_id, o.identity.office_id);
  assert.equal(s.host, os.hostname());
  assert.ok(!JSON.stringify(s).includes(o.identity.sign.d));
  assert.ok(!JSON.stringify(s).includes(o.identity.box.d));
});

test('self status reads this machine and its hive, shaped like a peer status', () => {
  const o = office('local');
  const st = selfStatus(o.identity, link, o.hive);
  assert.equal(st.self, true);
  assert.equal(st.hive, o.hive);
  assert.equal(st.capacity.cpus, os.cpus().length);
  assert.equal(st.capacity.workers_total, 2);
  assert.equal(st.capacity.workers_idle, 1);
  assert.equal(st.capacity.michael_state, 'idle');
});

test('without a hive, self still reports the host and Michael reads offline', () => {
  const o = office('nohive');
  const st = selfStatus(o.identity, link, null);
  assert.equal(st.hive, null);
  assert.equal(st.capacity.michael_state, 'offline');
  assert.ok(st.capacity.ram_total_gb > 0);
});

test('peer-only tools refuse self with a clear code', () => {
  const e = selfNotAPeer('munder_compose_submit');
  assert.equal(e.code, 'self_not_a_peer');
  assert.match(e.message, /no un peer/);
});
