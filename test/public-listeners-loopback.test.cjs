'use strict';

/**
 * The webhook and Slack receivers are reached from the internet ONLY through
 * tunnelmole, which forwards to localhost. Binding every interface also put
 * them on the LAN, secret-gated but reachable by anyone on the network. Both
 * must bind loopback. `listen()` is driven directly: `start()` would open a
 * real tunnel, and a unit test must never reach the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WebhookServer } = loadTs('src/main/webhook.ts');
const { SlackWebhookServer } = loadTs('src/main/slack.ts');

async function boundAddress(server) {
  await server.listen();
  try {
    return server.server.address();
  } finally {
    server.stop();
  }
}

test('webhook receiver binds loopback only', async () => {
  const s = new WebhookServer({
    port: 0,
    endpoints: [{ id: 'a', name: 'A', secret: 'x'.repeat(32), schema: '' }],
    onMessage: () => null,
    lookupStatus: () => null
  });
  const addr = await boundAddress(s);
  assert.equal(addr.address, '127.0.0.1');
});

test('Slack receiver binds loopback only', async () => {
  const s = new SlackWebhookServer({ port: 0, signingSecret: 'secret', onMessage: () => {} });
  const addr = await boundAddress(s);
  assert.equal(addr.address, '127.0.0.1');
});
