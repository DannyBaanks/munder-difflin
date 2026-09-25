// "self": the office this MCP server runs in, as opposed to its paired peers.
//
// `munder_link_peers` used to list only peers, so a client connected through
// machine A saw machine B's numbers and had no way to tell where it was
// standing. These helpers give the local office a name ("self", or its own
// office name/id) and read its status straight from disk: no network, no Link
// round-trip, nothing a peer could answer on our behalf.
import os from 'node:os';

export const SELF = 'self';

/** Does this `office` argument mean the local office? */
export function isSelfQuery(query, identity) {
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) return false;
  if (q === SELF) return true;
  const name = String(identity.name || '').toLowerCase();
  const short = name.replace(/^michael-/, '');
  return q === identity.office_id || q === name || (short !== '' && q === short);
}

/** Who "self" is, in the same shape as a peer summary. Never includes private keys. */
export function selfSummary(identity, link) {
  return {
    office_id: identity.office_id,
    name: identity.name,
    fingerprint: link.prettyFingerprint(identity.office_id),
    host: os.hostname(),
    platform: process.platform,
  };
}

/**
 * Local status, shaped like a peer's `status` result so a client can compare
 * both directly. The hive is optional: without one the host numbers still come
 * back and Michael reads as offline, exactly as a peer would report it.
 */
export function selfStatus(identity, link, hiveRoot) {
  let capacity;
  try {
    capacity = hiveRoot ? link.capacity(new link.Office(hiveRoot)) : { ...link.hostCapacity(), michael_state: 'offline' };
  } catch {
    capacity = { ...link.hostCapacity(), michael_state: 'offline' };
  }
  return {
    self: true,
    office: selfSummary(identity, link),
    hive: hiveRoot || null,
    capacity,
  };
}

/** Link operations (submit/get/message/cancel) travel to a peer; self is not one. */
export function selfNotAPeer(tool) {
  const err = new Error(
    `«self» es esta oficina, no un peer: ${tool} viaja por Munder Link a otra oficina. ` +
    'Para trabajar aquí mismo, usa Munder en esta máquina (o delega a una oficina emparejada).'
  );
  err.code = 'self_not_a_peer';
  return err;
}
