// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Office Packs — a business type's starter team, as a portable file.
 *
 * Onboarding asks one question ("what kind of business do you run?") and answers
 * it with a pack: the recommended cast, what each agent does, which connections
 * it needs, and when the office works. Packs ship inside the app, and can also
 * arrive from a file or a `dontbemichael://` link.
 *
 * THREE RULES THIS FILE ENFORCES, each from a recorded decision:
 *
 * 1. CORE AGENTS CANNOT BE DROPPED (Decision: Oscar in every pack). Finance
 *    applies to every business, so the core pack's agents are merged into every
 *    business pack. A pack may TUNE a core agent for its industry — restaurant
 *    Oscar watches food cost and supplier invoices — by declaring an agent with
 *    the same id; it cannot omit one. The owner may still leave Oscar unpicked,
 *    which is a choice made in the UI, not in the file.
 *
 * 2. AN IMPORTED PACK IS CAPPED AT "ASK ME" (Decision 7). Bundled packs ship
 *    inside the app and may set any default. Anything that arrived from a link or
 *    a file has every outward capability (send, post, reply, spend, delete)
 *    forced down to `'ask'` AT LOAD TIME, not in the UI, so the cap holds even if
 *    a screen forgets it. A "free restaurant pack" circulating in a group chat
 *    therefore cannot grant itself unattended access to a stranger's mailbox.
 *
 * 3. UNKNOWN FIELDS ARE ERRORS (Decision 13). Packs validate strict. A field this
 *    build does not understand must never be silently dropped: the owner would
 *    believe a setting applied when it did not. Hire manifests keep their lenient
 *    behaviour so existing links still import.
 *
 * Records carry `schemaVersion` and upgrade on read; a pack from a newer build is
 * refused with a plain message rather than a parse error (Decision 23).
 */

import {
  boundedArray,
  cappedString,
  checkUnknownKeys,
  isPlainObject,
  shapedString,
  type FieldErrors,
  type FieldStrictness
} from './manifestFields';
import {
  capOutwardLevels,
  validateAgentDefinition,
  type AgentDefinitionV2
} from './agentDefinition';

export const OFFICE_PACK_SPEC_V1 = 'dontbemichael/office-pack@1';
export const OFFICE_PACK_VERSION = 1;

/** Where a pack came from. Drives the import cap in rule 2 above. */
export type PackOrigin = 'bundled' | 'imported';

/** `HH:MM`, 24-hour, owner's local time. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Business type id and glyph id: one lowercase token. */
const SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;

export const WEEKDAYS: readonly string[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface OfficeWindow {
  start: string;
  end: string;
  /** Shown to the owner: "rush hours", "lunch". */
  label?: string;
}

export interface OfficeHours {
  days: string[];
  work: OfficeWindow;
  /** Windows inside `work` when the office takes a break. */
  pauses: OfficeWindow[];
}

export interface StarterMission {
  agentId: string;
  title: string;
  /** Weekly schedule expression, validated by `weeklySchedule.ts` at arm time. */
  schedule: string;
}

export interface OfficePack {
  spec: typeof OFFICE_PACK_SPEC_V1;
  schemaVersion: number;
  /** `restaurant-food`, or `core` for the core pack. */
  businessType: string;
  displayName: string;
  tagline: string;
  /** Pixel glyph id for the business-type tile (design review Decision 34). */
  glyph?: string;
  /** Every business pack inherits the core pack; the core pack omits this. */
  extends?: 'core';
  agents: AgentDefinitionV2[];
  /** Agent ids pre-checked on the team screen. */
  defaultPicks: string[];
  officeHours: OfficeHours;
  starterMissions?: StarterMission[];
}

export interface OfficePackValidation {
  ok: boolean;
  pack?: OfficePack;
  errors: string[];
}

const KNOWN_KEYS: readonly string[] = [
  'spec',
  'schemaVersion',
  'businessType',
  'displayName',
  'tagline',
  'glyph',
  'extends',
  'agents',
  'defaultPicks',
  'officeHours',
  'starterMissions'
];

const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [];

function migrate(raw: Record<string, unknown>, from: number): Record<string, unknown> {
  let current = raw;
  for (let v = from; v < OFFICE_PACK_VERSION; v++) {
    const step = MIGRATIONS[v - 1];
    if (step) current = step(current);
  }
  return { ...current, schemaVersion: OFFICE_PACK_VERSION };
}

function timeField(v: unknown, field: string, out: FieldErrors): string | undefined {
  const t = shapedString(v, TIME_RE, field, out, 'HH:MM, 24-hour');
  return t;
}

function officeWindow(raw: unknown, field: string, out: FieldErrors): OfficeWindow | undefined {
  if (!isPlainObject(raw)) {
    out.errors.push(`"${field}" must be an object`);
    return undefined;
  }
  const start = timeField(raw.start, `${field}.start`, out);
  const end = timeField(raw.end, `${field}.end`, out);
  const label = cappedString(raw.label, 40, `${field}.label`, out);
  if (!start || !end) return undefined;
  return { start, end, ...(label ? { label } : {}) };
}

function officeHours(raw: unknown, out: FieldErrors): OfficeHours | undefined {
  if (!isPlainObject(raw)) {
    out.errors.push('"officeHours" must be an object');
    return undefined;
  }
  const days =
    boundedArray(raw.days, 7, 'officeHours.days', out, (v, i, errs) => {
      if (typeof v === 'string' && WEEKDAYS.includes(v)) return v;
      errs.errors.push(`"officeHours.days[${i}]" must be one of ${WEEKDAYS.join(', ')}`);
      return undefined;
    }) ?? [];
  if (!days.length) out.errors.push('"officeHours.days" must list at least one day');
  const work = officeWindow(raw.work, 'officeHours.work', out);
  const pauses =
    boundedArray(raw.pauses, 6, 'officeHours.pauses', out, (v, i, errs) =>
      officeWindow(v, `officeHours.pauses[${i}]`, errs)
    ) ?? [];
  if (!work) return undefined;
  return { days, work, pauses };
}

/**
 * Merge the core pack into a business pack (rule 1).
 *
 * A business agent sharing a core agent's id REPLACES it wholesale rather than
 * deep-merging: a half-merged permission set is the kind of ambiguity that ends
 * with an owner believing a capability is off when it is on. Overriding means
 * restating the agent, which is verbose and unmistakable.
 */
export function mergeWithCore(pack: OfficePack, core: OfficePack): OfficePack {
  if (pack.businessType === 'core') return pack;
  const overridden = new Set(pack.agents.map((a) => a.id));
  const inherited = core.agents.filter((a) => !overridden.has(a.id));
  const agents = [...inherited, ...pack.agents];
  // Core agents are pre-checked unless the business pack says otherwise, so
  // finance appears on the team screen without every pack author remembering it.
  const picks = new Set(pack.defaultPicks);
  for (const a of core.agents) if (!overridden.has(a.id)) picks.add(a.id);
  return { ...pack, agents, defaultPicks: [...picks] };
}

/**
 * Validate an untrusted pack.
 *
 * `origin` decides the import cap: `'bundled'` keeps declared levels, `'imported'`
 * forces outward capabilities down to `'ask'` (rule 2).
 */
export function validateOfficePack(
  raw: unknown,
  origin: PackOrigin,
  strictness: FieldStrictness = 'strict'
): OfficePackValidation {
  const out: FieldErrors = { errors: [] };
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['pack must be a JSON object'] };
  }
  if (raw.spec !== OFFICE_PACK_SPEC_V1) {
    return { ok: false, errors: [`unsupported spec "${String(raw.spec)}" (expected "${OFFICE_PACK_SPEC_V1}")`] };
  }

  const declared = raw.schemaVersion === undefined ? OFFICE_PACK_VERSION : raw.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    return { ok: false, errors: ['"schemaVersion" must be a positive integer'] };
  }
  if (declared > OFFICE_PACK_VERSION) {
    return {
      ok: false,
      errors: [`this pack was made by a newer version of the app (format ${declared}); update the app to open it`]
    };
  }
  const o = declared < OFFICE_PACK_VERSION ? migrate(raw, declared) : raw;

  const businessType = shapedString(o.businessType, SLUG_RE, 'businessType', out);
  if (!businessType) out.errors.push('"businessType" is required');
  const displayName = cappedString(o.displayName, 40, 'displayName', out, true);
  const tagline = cappedString(o.tagline, 80, 'tagline', out, true);
  const glyph = shapedString(o.glyph, SLUG_RE, 'glyph', out);

  let extendsCore: 'core' | undefined;
  if (o.extends !== undefined) {
    if (o.extends === 'core') extendsCore = 'core';
    else out.errors.push('"extends" must be "core" when present');
  }

  const agents =
    boundedArray(o.agents, 12, 'agents', out, (v, i, errs) => {
      const res = validateAgentDefinition(v, strictness);
      if (!res.ok || !res.definition) {
        for (const e of res.errors) errs.errors.push(`agents[${i}]: ${e}`);
        return undefined;
      }
      return origin === 'imported' ? capOutwardLevels(res.definition) : res.definition;
    }) ?? [];
  if (!agents.length) out.errors.push('"agents" must list at least one agent');

  const ids = new Set(agents.map((a) => a.id));
  if (ids.size !== agents.length) out.errors.push('"agents" contains duplicate ids');

  const defaultPicks =
    boundedArray(o.defaultPicks, 12, 'defaultPicks', out, (v, i, errs) => {
      const id = shapedString(v, SLUG_RE, `defaultPicks[${i}]`, errs);
      if (!id) return undefined;
      // A pick naming an agent the pack does not define would silently
      // pre-check nothing, which reads to the owner as a broken screen.
      if (!ids.has(id)) {
        errs.errors.push(`"defaultPicks[${i}]" names "${id}", which this pack does not define`);
        return undefined;
      }
      return id;
    }) ?? [];

  const hours = officeHours(o.officeHours, out);

  const starterMissions = boundedArray(o.starterMissions, 12, 'starterMissions', out, (v, i, errs) => {
    if (!isPlainObject(v)) {
      errs.errors.push(`"starterMissions[${i}]" must be an object`);
      return undefined;
    }
    const agentId = shapedString(v.agentId, SLUG_RE, `starterMissions[${i}].agentId`, errs);
    const title = cappedString(v.title, 80, `starterMissions[${i}].title`, errs, true);
    const schedule = cappedString(v.schedule, 80, `starterMissions[${i}].schedule`, errs, true);
    if (!agentId || !title || !schedule) return undefined;
    if (!ids.has(agentId)) {
      errs.errors.push(`"starterMissions[${i}].agentId" names "${agentId}", which this pack does not define`);
      return undefined;
    }
    return { agentId, title, schedule };
  });

  checkUnknownKeys(o, KNOWN_KEYS, strictness, out, 'pack');

  if (out.errors.length || !businessType || !displayName || !tagline || !hours) {
    return { ok: false, errors: out.errors };
  }
  return {
    ok: true,
    errors: [],
    pack: {
      spec: OFFICE_PACK_SPEC_V1,
      schemaVersion: OFFICE_PACK_VERSION,
      businessType,
      displayName,
      tagline,
      agents,
      defaultPicks,
      officeHours: hours,
      ...(glyph ? { glyph } : {}),
      ...(extendsCore ? { extends: extendsCore } : {}),
      ...(starterMissions ? { starterMissions } : {})
    }
  };
}
