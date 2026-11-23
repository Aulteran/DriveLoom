// Limits for service attachments, in one place so they can later be made
// configurable. Also quoted in openapi.yaml.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_VISIT = 10;
export const MAX_FILE_NAME_CHARS = 200;
export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** The type from the file's leading bytes. The client's claim is never trusted. */
export function sniffAttachment(b: Buffer): AttachmentType | null {
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const EXT: Record<AttachmentType, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const defaultFileName = (t: AttachmentType): string => `attachment.${EXT[t]}`;

/**
 * A safe display name: no directory part, no control or invisible formatting
 * characters (newlines, bidi overrides), no lone surrogates, no leading or
 * trailing dots, 1 to 200 characters. Returns null when nothing is left.
 */
export function sanitiseFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd').normalize('NFC');
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  s = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  s = Array.from(s).slice(0, MAX_FILE_NAME_CHARS).join('').trim();
  return s || null;
}

/** `attachment; filename="ascii"; filename*=UTF-8''percent-encoded` (RFC 6266 / 8187). */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${enc}`;
}
