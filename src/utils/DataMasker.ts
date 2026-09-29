/**
 * Redaction of sensitive values before anything is logged, reported or attached.
 *
 * Rule 30/19: passwords, tokens, cookies, Authorization headers and API keys must never
 * appear in a log line, an Extent report or a CI artifact.
 */

import { MASKED_VALUE, SENSITIVE_KEYS } from '../constants/FrameworkConstants';

const normalise = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');
const SENSITIVE_SET = new Set(SENSITIVE_KEYS.map(normalise));

/** True when a property name denotes a secret. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normalise(key);
  if (SENSITIVE_SET.has(normalised)) return true;
  return [...SENSITIVE_SET].some((sensitive) => normalised.includes(sensitive));
}

/** Patterns that leak secrets even when the surrounding key looks harmless. */
const VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${MASKED_VALUE}` },
  { pattern: /\beyJ[A-Za-z0-9._-]{10,}/g, replacement: MASKED_VALUE },
  { pattern: /\btkn_[A-Za-z0-9-]{8,}/g, replacement: MASKED_VALUE },
  {
    pattern: /("(?:password|token|apiKey|api_key|secret)"\s*:\s*)"[^"]*"/gi,
    replacement: `$1"${MASKED_VALUE}"`,
  },
  {
    pattern: /\b(password|token|api[_-]?key|secret)=[^\s&;]+/gi,
    replacement: `$1=${MASKED_VALUE}`,
  },
];

/** Masks secrets inside a free-text string. */
export function maskString(value: string): string {
  return VALUE_PATTERNS.reduce(
    (masked, { pattern, replacement }) => masked.replace(pattern, replacement),
    value,
  );
}

/**
 * Deep-clones a value, replacing every sensitive property with a redaction marker.
 * Cyclic references collapse to `[Circular]` rather than throwing.
 */
export function maskValue<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => maskValue(item, seen));
  if (value instanceof Error) return { name: value.name, message: maskString(value.message) };

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? MASKED_VALUE : maskValue(item, seen);
  }
  return output;
}

/** Masks a header bag, preserving key casing for diagnostics. */
export function maskHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? MASKED_VALUE : maskString(value),
    ]),
  );
}

/** Masks a URL's query string while keeping the path readable. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, MASKED_VALUE);
    }
    return parsed.toString();
  } catch {
    return maskString(url);
  }
}
