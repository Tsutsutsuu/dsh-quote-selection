// Minimal ASAR reader: extracts files under a given path prefix.
// Usage: node asar-extract.mjs <app.asar> <prefixInsideAsar> <outDir>
import fs from 'node:fs'
import path from 'node:path'

const [, , asarPath, prefix, outDir] = process.argv
if (!asarPath || !prefix || !outDir) {
  console.error('usage: node asar-extract.mjs <app.asar> <prefix> <outDir>')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const baseOffset = 16 + headerSize

const normPrefix = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

function walk(node, rel, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const childRel = rel ? `${rel}/${name}` : name
    if (child.files) {
      if (normPrefix === childRel || normPrefix.startsWith(childRel + '/') || childRel.startsWith(normPrefix + '/') || normPrefix === '') {
        walk(child, childRel, out)
      }
    } else if (childRel === normPrefix || childRel.startsWith(normPrefix + '/') || normPrefix === '') {
      out.push({ rel: childRel, child })
    }
  }
}

const files = []
walk(header, '', files)
console.log(`matched ${files.length} files under "${normPrefix}"`)

let count = 0
for (const { rel, child } of files) {
  const dest = path.join(outDir, rel.slice(normPrefix === '' ? 0 : normPrefix.length).replace(/^\/+/, ''))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (child.unpacked) {
    const src = path.join(asarPath + '.unpacked', rel)
    if (fs.existsSync(src)) fs.copyFileSync(src, dest)
    else console.warn('missing unpacked', rel)
  } else {
    // child.offset is a string in asar headers
    const size = Number(child.size)
    const offset = baseOffset + Number(child.offset)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, offset)
    fs.writeFileSync(dest, buf)
  }
  count++
}
console.log(`extracted ${count} files to ${outDir}`)
fs.closeSync(fd)
