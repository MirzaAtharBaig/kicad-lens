// Generates media/icon.png (128×128): a magnifier lens over a PCB trace.
// Run: node media/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const N = 128;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, [r, g, b, a]) => {
  const i = (y * N + x) * 4;
  const k = a / 255;
  px[i] = Math.round(r * k + px[i] * (1 - k));
  px[i + 1] = Math.round(g * k + px[i + 1] * (1 - k));
  px[i + 2] = Math.round(b * k + px[i + 2] * (1 - k));
  px[i + 3] = Math.max(px[i + 3], a);
};
// Supersampled shape fill.
const shape = (inside, color) => {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
      if (hits) set(x, y, [...color.slice(0, 3), Math.round((color[3] * hits) / 16)]);
    }
};
const rounded = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const seg = (ax, ay, bx, by, w) => (x, y) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (w / 2) ** 2;
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ring = (cx, cy, r0, r1) => (x, y) => {
  const d = (x - cx) ** 2 + (y - cy) ** 2;
  return d <= r1 * r1 && d >= r0 * r0;
};

shape(rounded(4, 4, 124, 124, 22), [12, 70, 46, 255]); // board
shape(seg(14, 96, 44, 96, 7), [214, 168, 60, 255]); // traces
shape(seg(44, 96, 70, 70, 7), [214, 168, 60, 255]);
shape(seg(20, 30, 50, 30, 7), [214, 168, 60, 255]);
shape(circle(14, 96, 7), [214, 168, 60, 255]);
shape(circle(20, 30, 7), [214, 168, 60, 255]);
shape(circle(56, 56, 30), [229, 72, 77, 70]); // lens tint: removed
shape((x, y) => circle(56, 56, 30)(x, y) && x > 56, [48, 164, 108, 90]); // added half
shape(ring(56, 56, 28, 36), [240, 240, 240, 255]); // lens rim
shape(seg(82, 82, 112, 112, 13), [240, 240, 240, 255]); // handle

// PNG encoding
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(fileURLToPath(new URL('icon.png', import.meta.url)), png);
