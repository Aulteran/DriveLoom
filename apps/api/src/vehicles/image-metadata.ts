// Removes metadata from uploaded vehicle photos without re-encoding them.
// Phone photos carry EXIF with the place they were taken, the device and the
// time; a vehicle's members (and every backup) would otherwise receive it.
// Pixels are untouched: only metadata segments and chunks are dropped. A JPEG
// keeps its orientation, rewritten as the only EXIF field, so photos are not
// shown sideways. Anything that cannot be walked safely is refused (null).

/** JPEG APPn segments kept: JFIF (APP0), ICC colour profiles (APP2) and Adobe colour transform (APP14). */
const ICC = Buffer.from('ICC_PROFILE\0', 'latin1');
const EXIF = Buffer.from('Exif\0\0', 'latin1');

function exifOrientation(payload: Buffer): number | null {
  if (payload.length < EXIF.length + 8 || !payload.subarray(0, EXIF.length).equals(EXIF)) return null;
  const t = payload.subarray(EXIF.length);
  const order = t.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** An APP1 segment holding a single EXIF field: Orientation. */
function orientationSegment(v: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 follows the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(v, 18); // value, left-justified; bytes 20-21 stay zero
  // bytes 22-25: no next IFD
  const body = Buffer.concat([EXIF, tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function stripJpeg(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const m = b[i]!;
    const start = i - 1;
    i++;
    if (m === 0xd9) { out.push(b.subarray(start)); break; } // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(start, i)); continue; } // no length
    if (i + 2 > b.length) return null;
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) return null;
    const end = i + len;
    if (m === 0xda) { out.push(b.subarray(start)); break; } // start of scan: the rest is image data
    const payload = b.subarray(i + 2, end);
    const keep = (m < 0xe0 || m > 0xef) && m !== 0xfe
      ? true // tables, frame headers and other non-metadata markers
      : m === 0xe0 || m === 0xee || (m === 0xe2 && payload.subarray(0, ICC.length).equals(ICC));
    if (m === 0xe1 && orientation === null) orientation = exifOrientation(payload);
    if (keep) out.push(b.subarray(start, end));
    i = end;
  }
  if (orientation !== null && orientation !== 1) {
    const afterJfif = out[1] !== undefined && out[1][1] === 0xe0 ? 2 : 1;
    out.splice(afterJfif, 0, orientationSegment(orientation));
  }
  return Buffer.concat(out);
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    if (i + 12 > b.length) return null;
    const len = b.readUInt32BE(i);
    const end = i + 12 + len;
    if (end > b.length) return null;
    const type = b.toString('latin1', i + 4, i + 8);
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function stripWebp(b: Buffer): Buffer | null {
  const out: Buffer[] = [];
  let i = 12;
  while (i < b.length) {
    if (i + 8 > b.length) return null;
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) return null;
    const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
    if (type === 'VP8X' && len >= 1) chunk[8] = chunk[8]! & ~0x0c; // clear the EXIF and XMP flags
    if (type !== 'EXIF' && type !== 'XMP ') out.push(chunk);
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** Returns the image without metadata, or null when its structure cannot be read. */
export function stripImageMetadata(data: Buffer, type: 'image/jpeg' | 'image/png' | 'image/webp'): Buffer | null {
  try {
    if (type === 'image/jpeg') return stripJpeg(data);
    if (type === 'image/png') return stripPng(data);
    return stripWebp(data);
  } catch {
    return null;
  }
}
