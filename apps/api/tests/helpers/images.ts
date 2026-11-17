// Structurally valid image files for tests. Pixel data is not decodable; the
// server only walks segments and chunks, it never decodes pixels.

export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not checked
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function png(...extra: Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13, 1)), ...extra, pngChunk('IDAT', Buffer.alloc(32, 2)), pngChunk('IEND')]);
}

export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
export const JFIF = jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
/** EXIF with Orientation and a GPS marker string that must not survive. */
export function exif(orientation: number, extra = 'GPS 48.8584N 2.2945E'): Buffer {
  const t = Buffer.alloc(8 + 2 + 24 + 4);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(2, 8);
  t.writeUInt16LE(0x010f, 10); t.writeUInt16LE(2, 12); t.writeUInt32LE(4, 14); t.write('Cam', 18, 'latin1'); // Make
  t.writeUInt16LE(0x0112, 22); t.writeUInt16LE(3, 24); t.writeUInt32LE(1, 26); t.writeUInt16LE(orientation, 30);
  return jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, Buffer.from(extra, 'latin1')]));
}
export function jpeg(...segments: Buffer[]): Buffer {
  const sos = Buffer.concat([jpegSegment(0xda, Buffer.alloc(10, 0)), Buffer.alloc(32, 3)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, jpegSegment(0xdb, Buffer.alloc(65, 1)), sos, Buffer.from([0xff, 0xd9])]);
}

export function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
export function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
