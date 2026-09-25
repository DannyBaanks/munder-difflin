// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Shared field validators for untrusted manifests (design review Decision 13).
 *
 * Two manifest formats now cross the same trust boundary: the shareable hire
 * (`hire.ts`, spec `munder-difflin/hire@1`) and the Office Pack
 * (`officePack.ts`, spec `dontbemichael/office-pack@1`). They validate the same
 * KINDS of field — capped strings, enums, regex-shaped values, bounded arrays —
 * so the rules live here once instead of drifting apart in two files.
 *
 * STRICTNESS IS THE ONE DIFFERENCE, and it is explicit at the call site:
 *
 *   - `'lenient'` (hire): an unrecognized key is dropped silently. This is the
 *     historical behaviour and existing hire links depend on it — a manifest
 *     carrying a field from a newer gallery must still import today.
 *   - `'strict'` (pack): an unrecognized key is an ERROR. A pack grants agents
 *     access to a business's mail and money, so a field this build does not
 *     understand must never be silently ignored — the owner would believe a
 *     setting applied when it did not.
 *
 * Nothing here reads the filesystem, imports electron, or touches the network:
 * both main (deep-link / file import) and the renderer (prefill) use it, and the
 * unit tests load it under plain node through `test/load-ts.cjs`.
 */

/** How an unrecognized key is treated. See the module comment. */
export type FieldStrictness = 'lenient' | 'strict';

/** Collects validation problems; `ok` is derived from `errors.length`. */
export interface FieldErrors {
  errors: string[];
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * A trimmed string with a hard length cap.
 *
 * Returns `undefined` for absent/blank values rather than `''`, so a caller can
 * spread the result without writing empty strings into a record.
 */
export function cappedString(
  v: unknown,
  max: number,
  field: string,
  out: FieldErrors,
  required = false
): string | undefined {
  if (v === undefined || v === null) {
    if (required) out.errors.push(`"${field}" is required`);
    return undefined;
  }
  if (!isString(v)) {
    out.errors.push(`"${field}" must be a string`);
    return undefined;
  }
  const t = v.trim();
  if (required && !t) {
    out.errors.push(`"${field}" must not be empty`);
    return undefined;
  }
  if (t.length > max) {
    out.errors.push(`"${field}" exceeds ${max} chars`);
    return undefined;
  }
  return t || undefined;
}

/** One of a fixed set of literals. Case-sensitive: these are wire values. */
export function enumField<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field: string,
  out: FieldErrors
): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (isString(v) && (allowed as readonly string[]).includes(v)) return v as T;
  out.errors.push(`"${field}" must be one of ${allowed.join(', ')}`);
  return undefined;
}

/**
 * A string constrained by a shape regex.
 *
 * Used for values that reach a command line or a file path, where the character
 * set is the security boundary rather than the length (see `MODEL_RE` in
 * `hire.ts` for why: on Windows a `.cmd` shim routes through cmd.exe, so an
 * unquoted `&` or `|` would chain a second command).
 */
export function shapedString(
  v: unknown,
  re: RegExp,
  field: string,
  out: FieldErrors,
  hint = ''
): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isString(v)) {
    out.errors.push(`"${field}" must be a string`);
    return undefined;
  }
  const t = v.trim();
  if (!re.test(t)) {
    out.errors.push(`"${field}" contains disallowed characters${hint ? ` (${hint})` : ''}`);
    return undefined;
  }
  return t;
}

/**
 * An array of items, capped in length, each mapped through `item`.
 *
 * `item` returns `undefined` to drop an entry (it pushes its own error first),
 * so one bad element never discards the whole list — the caller decides whether
 * the accumulated errors are fatal.
 */
export function boundedArray<T>(
  v: unknown,
  maxItems: number,
  field: string,
  out: FieldErrors,
  item: (raw: unknown, index: number, out: FieldErrors) => T | undefined
): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    out.errors.push(`"${field}" must be an array`);
    return undefined;
  }
  if (v.length > maxItems) {
    out.errors.push(`"${field}" must have at most ${maxItems} items`);
    return undefined;
  }
  const kept: T[] = [];
  for (let i = 0; i < v.length; i++) {
    const mapped = item(v[i], i, out);
    if (mapped !== undefined) kept.push(mapped);
  }
  return kept.length ? kept : undefined;
}

/** A positive integer inside an inclusive range. */
export function intInRange(
  v: unknown,
  min: number,
  max: number,
  field: string,
  out: FieldErrors
): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
  out.errors.push(`"${field}" must be an integer between ${min} and ${max}`);
  return undefined;
}

/** A boolean, with a typed error rather than silent coercion. */
export function boolField(v: unknown, field: string, out: FieldErrors): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  out.errors.push(`"${field}" must be a boolean`);
  return undefined;
}

/**
 * Enforce the strictness contract for keys this build does not recognize.
 *
 * Call it once per object, AFTER every known field has been read, passing the
 * recognized key names. In `'strict'` mode each unknown key becomes an error; in
 * `'lenient'` mode it is ignored, matching how the hire validator has always
 * behaved (it rebuilds its output field by field, so unknown keys never survive).
 */
export function checkUnknownKeys(
  raw: Record<string, unknown>,
  known: readonly string[],
  strictness: FieldStrictness,
  out: FieldErrors,
  where = 'manifest'
): void {
  if (strictness !== 'strict') return;
  const allowed = new Set(known);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      out.errors.push(`${where} has unknown field "${key}", which this build does not understand`);
    }
  }
}

/** True when `raw` is a plain JSON object (not null, not an array). */
export function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
