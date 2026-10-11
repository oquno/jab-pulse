// Use the CLI's compatibility naming option and save a scannable QR image.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { createRequire } = require('node:module')
const cli = path.resolve(__dirname, '../node_modules/@zeppos/zeus-cli/bin/main.js')
const cliRequire = createRequire(cli)
const terminal = cliRequire('qrcode-terminal')
const qrRoot = path.resolve(path.dirname(cliRequire.resolve('qrcode-terminal')), '..')
const QRCode = require(path.join(qrRoot, 'vendor/QRCode'))
const original = terminal.generate

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
function qrPng(url) {
  const qr = new QRCode(-1, terminal.error)
  qr.addData(url)
  qr.make()
  const scale = 10, border = 4
  const size = (qr.getModuleCount() + border * 2) * scale
  const pixels = Buffer.alloc((size + 1) * size, 255)
  for (let y = 0; y < size; y++) {
    pixels[y * (size + 1)] = 0
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - border
      const col = Math.floor(x / scale) - border
      if (row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col)) {
        pixels[y * (size + 1) + x + 1] = 0
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header[8] = 8 // Grayscale, 8-bit, no interlace.
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
terminal.generate = function(url, options, callback) {
  const output = path.resolve(process.cwd(), 'dist')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'preview-qr.png'), qrPng(url))
  fs.writeFileSync(path.join(output, 'preview.json'), JSON.stringify({ url, createdAt: new Date().toISOString() }, null, 2))
  original.call(this, url, options, callback)
  console.log('QR image: ' + path.join(output, 'preview-qr.png'))
}
process.argv = [process.execPath, cli, 'preview', '--target', 'Amazfit Bip 6',
  '--legacyZpkName', 'true', '--legacy-zpk-name', ...process.argv.slice(2)]
require(cli)
