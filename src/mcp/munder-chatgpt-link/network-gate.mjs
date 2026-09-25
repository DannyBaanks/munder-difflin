import os from 'node:os';
import net from 'node:net';

function ipv4ToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function extractHost(address) {
  const s = String(address || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end >= 0 ? s.slice(1, end) : s;
  }
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount === 1) return s.split(':')[0];
  return s;
}

function isTailscaleIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const start = ipv4ToInt('100.64.0.0');
  const end = ipv4ToInt('100.127.255.255');
  return n >= start && n <= end;
}

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isLoopback(ip) {
  if (ip === '::1') return true;
  const n = ipv4ToInt(ip);
  return n !== null && ((n >>> 24) & 0xff) === 127;
}

function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase();
  return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

function sameIpv4Subnet(remoteIp, ifaceAddress, netmask) {
  const r = ipv4ToInt(remoteIp);
  const i = ipv4ToInt(ifaceAddress);
  const m = ipv4ToInt(netmask);
  if (r === null || i === null || m === null) return false;
  return (r & m) === (i & m);
}

function localInterfaces() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const e of entries || []) {
      out.push({
        name,
        address: e.address,
        family: e.family,
        netmask: e.netmask,
        internal: Boolean(e.internal),
        cidr: e.cidr || null,
      });
    }
  }
  return out;
}

export function classifyReachability(address, interfaces = localInterfaces()) {
  const host = extractHost(address);
  const family = net.isIP(host);

  if (!family) {
    return { ok: false, host, class: 'unknown', reason: 'address is not a literal IP' };
  }

  if (isLoopback(host)) {
    return { ok: true, host, class: 'loopback', reason: 'same host' };
  }

  if (family === 4 && isTailscaleIPv4(host)) {
    return { ok: true, host, class: 'tailscale', reason: 'Tailscale CGNAT range' };
  }

  if (family === 4) {
    const match = interfaces.find((e) => e.family === 'IPv4' && !e.internal && sameIpv4Subnet(host, e.address, e.netmask));
    if (match) {
      return {
        ok: true,
        host,
        class: 'same_lan',
        reason: `same IPv4 subnet as ${match.name}`,
        local_interface: { name: match.name, address: match.address, cidr: match.cidr },
      };
    }
    if (isPrivateIPv4(host)) {
      return { ok: false, host, class: 'private_routed', reason: 'private IP, but not on a local IPv4 subnet' };
    }
  }

  if (family === 6 && isPrivateIPv6(host)) {
    return { ok: false, host, class: 'private_ipv6', reason: 'private/link-local IPv6; explicit route verification not implemented' };
  }

  return { ok: false, host, class: 'public', reason: 'public or otherwise non-local address' };
}

export function gateReachability(address, options = {}) {
  const result = classifyReachability(address, options.interfaces);
  const allowPublic = options.allowPublic ?? process.env.MUNDER_CHATGPT_ALLOW_PUBLIC === '1';
  const allowPrivateRouted = options.allowPrivateRouted ?? process.env.MUNDER_CHATGPT_ALLOW_PRIVATE_ROUTED === '1';

  if (result.ok) return result;
  if (allowPublic && result.class === 'public') return { ...result, ok: true, reason: `${result.reason}; explicitly allowed` };
  if (allowPrivateRouted && ['private_routed', 'private_ipv6'].includes(result.class)) {
    return { ...result, ok: true, reason: `${result.reason}; explicitly allowed` };
  }
  return result;
}

export { extractHost, ipv4ToInt, isTailscaleIPv4, sameIpv4Subnet };
