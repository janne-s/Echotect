function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const bytesOf = value => value instanceof Uint8Array ? value : new Uint8Array(value);

export function zipStore(files) {
  const encoder = new TextEncoder();
  const entries = files.map(file => ({ name: encoder.encode(file.name), data: bytesOf(file.data) }));
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  if (entries.length > 0xffff || localSize + centralSize + 22 > 0xffffffff) throw new Error('Export package exceeds the ZIP32 size limit. Export fewer files at a time.');
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const records = [];
  for (const entry of entries) {
    const checksum = crc32(entry.data);
    records.push({ ...entry, checksum, offset });
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint32(offset + 14, checksum, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    output.set(entry.name, offset + 30);
    output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  for (const entry of records) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint32(offset + 16, entry.checksum, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint32(offset + 42, entry.offset, true);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  return output;
}

/**
 * The files of a stored (uncompressed) ZIP archive, such as Boomtect's and Echotect's own export
 * packages: [{ name, data }], read from the central directory and checked against their checksums.
 */
export function unzipStored(bytes) {
  const data = bytesOf(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('The file is not a ZIP archive.');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The ZIP archive is damaged.');
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    if (method !== 0) throw new Error(`${name} is compressed; only stored ZIP archives can be opened.`);
    if (local + 30 > data.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('The ZIP archive is damaged.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > data.length) throw new Error('The ZIP archive is damaged.');
    const content = data.slice(start, start + size);
    if (crc32(content) !== checksum) throw new Error(`${name} does not match its checksum.`);
    files.push({ name, data: content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
