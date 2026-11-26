const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function findEndOfCentralDirectory(buf) {
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/* Just enough zip to unpack a jar or a runtime archive: read the central
   directory, then inflate each entry. Handles stored and deflated entries,
   which is all Mojang archives and Adoptium builds use. `remap` can land an
   entry somewhere else or skip it (null). */
function extractZip(src, destination, { filter, onEntry, remap } = {}) {
  const buf = fs.readFileSync(src);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error(`Not a zip archive: ${path.basename(src)}`);

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(destination);
  let written = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) break;

    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    if (filter && !filter(name)) continue;

    const mapped = remap ? remap(name) : name;
    if (!mapped) continue;

    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    const target = path.resolve(root, mapped);
    if (!target.startsWith(root + path.sep)) continue;

    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written += 1;
    if (onEntry) onEntry(name, data.length);
  }

  return written;
}

/* Reads one stored/deflated entry without unpacking the archive, for peeking
   at a jar's metadata before anything is installed. */
function readZipEntry(src, wanted) {
  const buf = fs.readFileSync(src);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) return null;

  const entryCount = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) return null;

    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name === wanted) {
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
  }
  return null;
}

module.exports = { extractZip, readZipEntry };
