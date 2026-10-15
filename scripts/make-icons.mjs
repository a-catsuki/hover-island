import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'src-tauri', 'icons')
const pubDir = path.join(root, 'public')
mkdirSync(outDir, { recursive: true })
mkdirSync(pubDir, { recursive: true })

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function png(size, draw) {
  const bpr = size * 4 + 1
  const raw = Buffer.alloc(bpr * size)
  for (let y = 0; y < size; y++) {
    raw[y * bpr] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw((x + 0.5) / size, (y + 0.5) / size, size)
      const o = y * bpr + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
function roundRectSDF(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function draw(u, v, size) {
  const edge = 1.2 / size
  // app tile
  const dTile = roundRectSDF(u, v, 0.5, 0.5, 0.5, 0.5, 0.235)
  const aTile = 1 - smooth(-edge, edge, dTile)
  if (aTile <= 0) return [0, 0, 0, 0]

  // tile gradient (near-black, slight blue)
  const t = v
  let R = 14 + 8 * t
  let G = 14 + 9 * t
  let B = 20 + 16 * t

  // ambient glow behind the island
  const gx = u - 0.5
  const gy = v - 0.32
  const glow = Math.exp(-(gx * gx * 12 + gy * gy * 16)) * 0.7
  R += 70 * glow
  G += 86 * glow
  B += 150 * glow

  // the island pill
  const dPill = roundRectSDF(u, v, 0.5, 0.325, 0.2, 0.045, 0.045)
  const aPill = 1 - smooth(-edge, edge, dPill)
  if (aPill > 0) {
    const sh = (u - 0.3) / 0.4
    R = R * (1 - aPill) + (222 + 33 * sh) * aPill
    G = G * (1 - aPill) + (228 + 27 * sh) * aPill
    B = B * (1 - aPill) + (255) * aPill
  }

  // under-glow beneath the pill
  const ug = Math.exp(-(gx * gx * 20 + (v - 0.44) * (v - 0.44) * 60)) * 0.5
  R += 40 * ug
  G += 50 * ug
  B += 90 * ug

  return [Math.min(255, R) | 0, Math.min(255, G) | 0, Math.min(255, B) | 0, (aTile * 255) | 0]
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = new Map()
for (const s of sizes) pngs.set(s, png(s, draw))

writeFileSync(path.join(outDir, '32x32.png'), pngs.get(32))
writeFileSync(path.join(outDir, '128x128.png'), pngs.get(128))
writeFileSync(path.join(outDir, '128x128@2x.png'), pngs.get(256))
writeFileSync(path.join(outDir, 'icon.png'), pngs.get(256))
writeFileSync(path.join(pubDir, 'icon.png'), pngs.get(256))

// ---- multi-size .ico (PNG-compressed entries, Vista+) ----
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
let offset = 6 + 16 * icoSizes.length
const entries = []
const datas = []
for (const s of icoSizes) {
  const data = pngs.get(s) ?? png(s, draw)
  const e = Buffer.alloc(16)
  e[0] = s >= 256 ? 0 : s
  e[1] = s >= 256 ? 0 : s
  e[2] = 0
  e[3] = 0
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += data.length
  entries.push(e)
  datas.push(data)
}
writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...datas]))

console.log('icons written ->', outDir)
console.log('sizes:', icoSizes.join(', '))
