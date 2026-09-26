'use strict';

// Munder Mobile talks to the office over plain HTTP (the payload is encrypted
// end to end by RemoteCrypto), at its LAN address at home and its Tailscale
// address (100.64.0.0/10) away from home. App Transport Security has to allow
// both. The trap: on iOS 10+, if NSAllowsLocalNetworking (or the media/web
// variants) is present, NSAllowsArbitraryLoads is ignored and only local hosts
// are allowed. That blocked pairing over Tailscale with "The resource could
// not be loaded because the App Transport Security policy requires the use of
// a secure connection".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plist = fs.readFileSync(path.join(__dirname, '..', 'ios', 'MunderMobile', 'Info.plist'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');
const ats = (plist.match(/<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/) || [])[1];

test('ATS allows arbitrary loads (the office is reached by IP, LAN or Tailscale)', () => {
  assert.ok(ats, 'NSAppTransportSecurity dict present');
  assert.match(ats, /<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
});

test('no key that makes iOS ignore NSAllowsArbitraryLoads', () => {
  for (const k of ['NSAllowsLocalNetworking', 'NSAllowsArbitraryLoadsForMedia', 'NSAllowsArbitraryLoadsInWebContent']) {
    assert.doesNotMatch(ats, new RegExp(`<key>${k}</key>`), `${k} would disable NSAllowsArbitraryLoads on iOS 10+`);
  }
});
