import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReachability } from './network-gate.mjs';

const interfaces = [
  { name: 'eth0', family: 'IPv4', internal: false, address: '192.168.1.10', netmask: '255.255.255.0', cidr: '192.168.1.10/24' },
  { name: 'tailscale0', family: 'IPv4', internal: false, address: '100.80.1.2', netmask: '255.192.0.0', cidr: '100.80.1.2/10' },
];

test('accepts loopback', () => {
  assert.equal(classifyReachability('127.0.0.1:47831', interfaces).class, 'loopback');
});

test('accepts same LAN subnet', () => {
  const r = classifyReachability('192.168.1.82:47831', interfaces);
  assert.equal(r.ok, true);
  assert.equal(r.class, 'same_lan');
});

test('accepts Tailscale range', () => {
  const r = classifyReachability('100.115.163.4:47831', interfaces);
  assert.equal(r.ok, true);
  assert.equal(r.class, 'tailscale');
});

test('rejects private address outside local subnet by default', () => {
  const r = classifyReachability('10.9.0.2:47831', interfaces);
  assert.equal(r.ok, false);
  assert.equal(r.class, 'private_routed');
});

test('rejects public address by default', () => {
  const r = classifyReachability('8.8.8.8:47831', interfaces);
  assert.equal(r.ok, false);
  assert.equal(r.class, 'public');
});
