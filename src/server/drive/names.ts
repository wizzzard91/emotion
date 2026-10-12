import { DriveError } from './errors.ts';

export const MAX_NAME_LENGTH = 255;

// Path separators, control characters and bidi overrides (used to fake extensions).
const BAD_CHARS = /[/\\\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const BAD_CHARS_ALL = new RegExp(BAD_CHARS.source, 'gu');

const length = (s: string) => [...s].length;
const cut = (s: string, max: number) => [...s].slice(0, Math.max(max, 0)).join('');

/** Validates a name typed by the user; returns it normalised or throws bad_name. */
export function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw new DriveError('bad_name');
  const name = raw.normalize('NFC').trim();
  if (name === '' || name === '.' || name === '..' || length(name) > MAX_NAME_LENGTH || BAD_CHARS.test(name)) {
    throw new DriveError('bad_name');
  }
  return name;
}

/** An uploaded file's name is never rejected, only coerced into a valid one. */
export function sanitizeFileName(raw: string): string {
  let name = raw.normalize('NFC').replace(BAD_CHARS_ALL, '_').trim();
  if (name === '' || name === '.' || name === '..') name = 'файл';
  if (length(name) > MAX_NAME_LENGTH) {
    const [base, ext] = splitExt(name);
    name = cut(base, MAX_NAME_LENGTH - length(ext)) + ext;
  }
  return name;
}

/** Key for comparing names: case-insensitive and Unicode-normalised. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function splitExt(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 20) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/** "report.pdf" → "report (2).pdf" when the name is taken. `taken` is a set of nameKey values. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(nameKey(name))) return name;
  const [base, ext] = splitExt(name);
  for (let n = 2; ; n++) {
    const tail = ` (${n})${ext}`;
    const candidate = cut(base, MAX_NAME_LENGTH - length(tail)) + tail;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/** Natural ordering: "file 2" before "file 10", case-insensitive. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
