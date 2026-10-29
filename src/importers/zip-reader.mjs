// Read ZIP members in process on every desktop platform. Nothing is extracted to disk.
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

/**
 * Opens a ZIP file or buffer once, so several members can be read without reading the central
 * directory again. `names` lists every member in archive order. Call close() when done.
 */
export async function openZipArchive(source, maximumNameBytes = 1024 * 1024) {
  // The archive stays open after its entries are listed, so members can be read in any order.
  const options = { strictFileNames: true, validateEntrySizes: true, autoClose: false };
  const zip = Buffer.isBuffer(source) ? await yauzl.fromBufferPromise(source, options) : await yauzl.openPromise(source, options);
  const names = [];
  const entries = new Map();
  try {
    let bytes = 0;
    for await (const entry of zip.eachEntry()) {
      if (/[\u0000-\u001f\u007f]/u.test(entry.fileName)) throw new Error("Unsupported ZIP member name.");
      bytes += Buffer.byteLength(entry.fileName, "utf8") + 1;
      if (bytes > maximumNameBytes) throw new Error("ZIP member list exceeds the supported size.");
      names.push(entry.fileName);
      if (!entries.has(entry.fileName)) entries.set(entry.fileName, entry);
    }
  } catch (error) {
    zip.close();
    throw error;
  }

  async function read(name, maximumBytes) {
    const entry = entries.get(name);
    if (!entry) throw new Error("ZIP member was not found.");
    if (entry.uncompressedSize > maximumBytes) throw new Error("ZIP member exceeds the supported size.");
    const stream = await zip.openReadStreamPromise(entry);
    const chunks = [];
    let bytes = 0;
    let checksum = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > maximumBytes) throw new Error("ZIP member exceeds the supported size.");
        checksum = crc32(chunk, checksum);
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    if (checksum !== entry.crc32) throw new Error("ZIP member checksum does not match.");
    return Buffer.concat(chunks, bytes);
  }

  return { names, read, close: () => zip.close() };
}

export async function listZipMembers(source, maximumBytes = 1024 * 1024) {
  const zip = await openZipArchive(source, maximumBytes);
  zip.close();
  return zip.names;
}

export async function readZipMember(source, name, maximumBytes) {
  const zip = await openZipArchive(source);
  try { return await zip.read(name, maximumBytes); } finally { zip.close(); }
}
