// Read ZIP members in process on every desktop platform. Nothing is extracted to disk.
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

async function openZip(source) {
  const options = { strictFileNames: true, validateEntrySizes: true };
  return Buffer.isBuffer(source) ? yauzl.fromBufferPromise(source, options) : yauzl.openPromise(source, options);
}

export async function listZipMembers(source, maximumBytes = 1024 * 1024) {
  const zip = await openZip(source);
  const names = [];
  let bytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (/[\u0000-\u001f\u007f]/u.test(entry.fileName)) throw new Error("Unsupported ZIP member name.");
      bytes += Buffer.byteLength(entry.fileName, "utf8") + 1;
      if (bytes > maximumBytes) throw new Error("ZIP member list exceeds the supported size.");
      names.push(entry.fileName);
    }
    return names;
  } finally { zip.close(); }
}

export async function readZipMember(source, name, maximumBytes) {
  const zip = await openZip(source);
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== name) continue;
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
    throw new Error("ZIP member was not found.");
  } finally { zip.close(); }
}
