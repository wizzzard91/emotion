const UNITS = ['Б', 'КБ', 'МБ', 'ГБ'];

/** 1536 → "1,5 КБ". */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${text} ${UNITS[unit]}`;
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function formatDate(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
    .format(date)
    .replace(',', '');
}

// Types that are safe to render in the browser. Everything else (html, svg, js…) is served
// as application/octet-stream, otherwise we would have stored XSS on our own origin.
// The type comes from the extension, not from what the client claimed at upload time.
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** MIME type for in-browser viewing, or null when the file is download-only. */
export function inlineType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(INLINE_TYPES, ext) ? INLINE_TYPES[ext]! : null;
}

/** Content-Disposition with an ASCII fallback name and an RFC 5987 filename*. */
export function contentDisposition(name: string, inline = false): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
