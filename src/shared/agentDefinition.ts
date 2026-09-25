// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Agent Definition v2 — what an agent is, in the owner's terms.
 *
 * The shareable hire manifest (`hire.ts`) describes an agent as a spawn command:
 * provider, model, flags, a goal string. That is a developer's view. A business
 * owner needs a different one, and eng review Decisions 2, 4 and 9 fixed it:
 *
 *   role       — "Admin", "Customer Care": the job title on the card
 *   does       — plain-language rules the owner can edit
 *   wontDo     — the same, for what the agent leaves alone
 *   tools      — per-capability level: off | ask | auto
 *   connections— which configured connections this agent may use
 *
 * TWO THINGS THIS FILE IS NOT:
 *
 * 1. It is NOT the enforcement point. `does`/`wontDo` compile into prompt text,
 *    which is reinforcement only. A level is enforced by the broker (it holds the
 *    credential) and by the PreToolUse allowlist hook — see Decision 9. Anything
 *    here is a declaration of intent that those layers then honour.
 * 2. It does NOT own connections. Connections are configured once, centrally
 *    (Decision 9); an agent references them by id and carries only the levels.
 *    Two agents sharing one mailbox produce one credential record, not two.
 *
 * Levels, in the owner's words on the setup screen:
 *   'off'  — "Off": the capability is denied; the tool is not offered and the
 *            broker refuses the call even if the agent finds another route.
 *   'ask'  — "Ask me": the call becomes a pending approval the owner acts on
 *            later, possibly hours later (Decisions 3, 10, 31).
 *   'auto' — "On its own": the call proceeds unattended.
 *
 * Every record carries `schemaVersion` (Decision 23). Owners auto-update, so a
 * build from January will read records written by a build from March: an older
 * record is upgraded on read, and a NEWER one is refused with a plain message
 * rather than a parse error.
 */

import {
  boundedArray,
  boolField,
  cappedString,
  checkUnknownKeys,
  enumField,
  intInRange,
  isPlainObject,
  shapedString,
  type FieldErrors,
  type FieldStrictness
} from './manifestFields';
import { MAX_AGENT_TOKEN_CAP } from './tokenCaps';

/** Current Agent Definition schema version. Bump only with a migration. */
export const AGENT_DEFINITION_VERSION = 1;

export type ToolLevel = 'off' | 'ask' | 'auto';

export const TOOL_LEVELS: readonly ToolLevel[] = ['off', 'ask', 'auto'];

/**
 * Capabilities whose effect leaves the building: they send, post, publish, pay
 * or delete on the owner's behalf. Decision 7 caps these at `'ask'` for any pack
 * that arrived from outside the app, so an imported pack can never grant itself
 * unattended reach into a stranger's mailbox or social account.
 *
 * Read-shaped capabilities (`email.read`, `reviews.read`) are deliberately absent:
 * they are still gated per agent, but an imported pack may pre-set them to `auto`
 * because the blast radius of an unwanted read is the owner's own data.
 */
export const OUTWARD_CAPABILITIES: ReadonlySet<string> = new Set([
  'email.send',
  'email.delete',
  'social.post',
  'site.publish',
  'campaign.send',
  'reviews.reply',
  'calendar.write',
  'books.write',
  'money.move'
]);

/** Capability id: `area.verb`, lowercase. Kept shape-checked because it is a map key. */
const CAPABILITY_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

/** Agent id: one path-safe token; it names a folder under the hive root. */
const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** One safe folder name, 1–40 characters. See the `folder` check in the validator. */
export const FOLDER_NAME_RE = /^(?![.\s])[^\\/:*?"<>|\x00-\x1f]{1,40}(?<![.\s])$/;
/** Connection id: matches the integration registry's slug shape. */
const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ToolGrant {
  /** e.g. `email.read`, `social.post`. */
  capability: string;
  level: ToolLevel;
}

export interface ConnectionRef {
  /** Id of a connection configured centrally (Decision 9). */
  id: string;
  /** When true, the agent cannot start work until this connection exists. */
  required: boolean;
}

export interface AgentDefinitionV2 {
  schemaVersion: number;
  /** Stable id: the hive folder name and the pack's reference key. */
  id: string;
  /** Office cast sprite id (`pam`, `oscar`); unknown values fall back at render. */
  character?: string;
  /** Job title shown on the card: "Admin", "Finance". */
  role: string;
  /** One plain sentence describing the job, shown on the team picker. */
  summary: string;
  /** Editable starting rules. Not enforcement — see the module comment. */
  does: string[];
  /** Editable starting rules for what the agent leaves alone. */
  wontDo: string[];
  /** Connections this agent may use, by id. */
  connections: ConnectionRef[];
  /** Per-capability levels. A capability absent here is treated as `'off'`. */
  tools: ToolGrant[];
  /** Friendly model tier; the concrete model id is resolved in main, never shown. */
  modelTier?: 'best' | 'fast';
  /** Per-agent total-token ceiling. */
  tokenCap?: number;
  /**
   * What this agent will do first, shown on the floor before anything has
   * happened (design review Decision 29). A reactive agent states its trigger
   * ("when a catering enquiry arrives") instead of a time.
   */
  firstAction?: string;
  /**
   * The folder this agent works in, by name — "Finance", "Marketing" (Decision
   * 47). It becomes `~/Documents/<Business>/<folder>` unless the owner points it
   * somewhere else, and it is the agent's working directory (Decision 44).
   * Agents that name the same folder share it.
   */
  folder?: string;
}

export interface AgentDefinitionValidation {
  ok: boolean;
  definition?: AgentDefinitionV2;
  errors: string[];
}

const KNOWN_KEYS: readonly string[] = [
  'schemaVersion',
  'id',
  'character',
  'role',
  'summary',
  'does',
  'wontDo',
  'connections',
  'tools',
  'modelTier',
  'tokenCap',
  'firstAction',
  'folder'
];

/** The level an agent has for a capability. Absent means `'off'` — default deny. */
export function levelFor(def: AgentDefinitionV2, capability: string): ToolLevel {
  return def.tools.find((t) => t.capability === capability)?.level ?? 'off';
}

/**
 * Cap outward capabilities at `'ask'` (Decision 7).
 *
 * Applied by the pack loader to anything that did not ship inside the app, so the
 * cap holds even when a UI forgets to apply it. Read capabilities pass through.
 */
export function capOutwardLevels(def: AgentDefinitionV2): AgentDefinitionV2 {
  let changed = false;
  const tools = def.tools.map((t) => {
    if (t.level === 'auto' && OUTWARD_CAPABILITIES.has(t.capability)) {
      changed = true;
      return { capability: t.capability, level: 'ask' as ToolLevel };
    }
    return t;
  });
  return changed ? { ...def, tools } : def;
}

/**
 * Upgrade an older record in place (Decision 23).
 *
 * One function per version step, applied in order. There are no steps yet —
 * version 1 is the first — but the seam exists so the first migration is an
 * append rather than a refactor, mirroring how `db.ts` handles SQLite.
 */
const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [];

function migrate(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  let current = raw;
  for (let v = from; v < AGENT_DEFINITION_VERSION; v++) {
    const step = MIGRATIONS[v - 1];
    if (step) current = step(current);
  }
  return { ...current, schemaVersion: AGENT_DEFINITION_VERSION };
}

/**
 * Validate an untrusted agent definition.
 *
 * `strictness` follows Decision 13: packs validate `'strict'` (an unknown field
 * is an error, because a pack grants access), everything else may be `'lenient'`.
 */
export function validateAgentDefinition(
  raw: unknown,
  strictness: FieldStrictness = 'strict'
): AgentDefinitionValidation {
  const out: FieldErrors = { errors: [] };
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['agent definition must be a JSON object'] };
  }

  // Version first: a record from a newer build is refused with a plain message
  // rather than being half-read by fields this build happens to recognize.
  const declared = raw.schemaVersion === undefined ? AGENT_DEFINITION_VERSION : raw.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    return { ok: false, errors: ['"schemaVersion" must be a positive integer'] };
  }
  if (declared > AGENT_DEFINITION_VERSION) {
    return {
      ok: false,
      errors: [`this agent was saved by a newer version of the app (format ${declared}); update the app to open it`]
    };
  }
  const o = declared < AGENT_DEFINITION_VERSION ? migrate(raw, declared) : raw;

  const id = shapedString(o.id, AGENT_ID_RE, 'id', out, 'lowercase letters, digits and dashes');
  if (!id) out.errors.push('"id" is required');
  const role = cappedString(o.role, 40, 'role', out, true);
  const summary = cappedString(o.summary, 200, 'summary', out, true);
  const character = cappedString(o.character, 24, 'character', out)?.toLowerCase();
  const modelTier = enumField(o.modelTier, ['best', 'fast'] as const, 'modelTier', out);
  const tokenCap = intInRange(o.tokenCap, 1, MAX_AGENT_TOKEN_CAP, 'tokenCap', out);
  const firstAction = cappedString(o.firstAction, 200, 'firstAction', out);
  // A folder name becomes a real path on the owner's disk, and packs can be
  // imported from anywhere: one plain name only. No slashes (so no `../`
  // escape), no leading dot (no hidden folders), none of the characters
  // Windows forbids, and no trailing dot or space, which Windows strips.
  const folder = shapedString(o.folder, FOLDER_NAME_RE, 'folder', out, 'a plain folder name, like "Finance"');

  const rule = (field: string) => (v: unknown, i: number, errs: FieldErrors) =>
    cappedString(v, 200, `${field}[${i}]`, errs);
  const does = boundedArray(o.does, 12, 'does', out, rule('does')) ?? [];
  const wontDo = boundedArray(o.wontDo, 12, 'wontDo', out, rule('wontDo')) ?? [];

  const connections =
    boundedArray(o.connections, 8, 'connections', out, (v, i, errs) => {
      if (!isPlainObject(v)) {
        errs.errors.push(`"connections[${i}]" must be an object`);
        return undefined;
      }
      const cid = shapedString(v.id, CONNECTION_ID_RE, `connections[${i}].id`, errs);
      if (!cid) return undefined;
      return { id: cid, required: boolField(v.required, `connections[${i}].required`, errs) ?? false };
    }) ?? [];

  const seen = new Set<string>();
  const tools =
    boundedArray(o.tools, 24, 'tools', out, (v, i, errs) => {
      if (!isPlainObject(v)) {
        errs.errors.push(`"tools[${i}]" must be an object`);
        return undefined;
      }
      const capability = shapedString(v.capability, CAPABILITY_RE, `tools[${i}].capability`, errs, 'area.verb');
      const level = enumField(v.level, TOOL_LEVELS, `tools[${i}].level`, errs);
      if (!capability || !level) return undefined;
      // A duplicated capability is ambiguous about which level applies, and the
      // safe reading (lowest) would silently contradict what the owner sees.
      if (seen.has(capability)) {
        errs.errors.push(`"tools" lists "${capability}" twice`);
        return undefined;
      }
      seen.add(capability);
      return { capability, level };
    }) ?? [];

  checkUnknownKeys(o, KNOWN_KEYS, strictness, out, 'agent definition');

  if (out.errors.length || !id || !role || !summary) {
    return { ok: false, errors: out.errors };
  }
  return {
    ok: true,
    errors: [],
    definition: {
      schemaVersion: AGENT_DEFINITION_VERSION,
      id,
      role,
      summary,
      does,
      wontDo,
      connections,
      tools,
      ...(character ? { character } : {}),
      ...(modelTier ? { modelTier } : {}),
      ...(tokenCap ? { tokenCap } : {}),
      ...(firstAction ? { firstAction } : {}),
      ...(folder ? { folder } : {})
    }
  };
}
