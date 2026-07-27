import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import yauzl from 'yauzl';
import { getSupportedExtensions } from './SystemDetector.js';

/**
 * Load a ROM file, extracting from ZIP if necessary.
 * Returns { data: Buffer, romPath: string, originalPath: string }
 * - data: the ROM file contents
 * - romPath: the effective ROM path (for extension detection and save naming)
 * - originalPath: the original input path
 */
export async function loadRom(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.zip') {
    return extractRomFromZip(inputPath);
  }

  // Regular file - read directly
  const data = await fs.readFile(inputPath);
  let romPath = inputPath;

  // .bin is ambiguous — check magic bytes for N64 ROM signatures
  if (ext === '.bin' && data.length >= 4) {
    const magic = data.readUInt32BE(0);
    if (magic === 0x80371240 || magic === 0x40123780 || magic === 0x37804012) {
      romPath = inputPath.replace(/\.bin$/i, '.z64');
    }
  }

  return {
    data,
    romPath,
    originalPath: inputPath,
  };
}

/**
 * Extract the first ROM file from a ZIP archive.
 */
async function extractRomFromZip(zipPath) {
  const supportedExtensions = new Set(getSupportedExtensions());

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(new Error(`Failed to open ZIP: ${err.message}`));
        return;
      }

      let foundRom = null;
      // Settle EXACTLY once, and never on the 'close' event alone: with
      // lazyEntries, calling close() from inside an entry's read stream does
      // not reliably emit 'close', so waiting for it hung the whole load. The
      // symptom was not an error — node exited 13 with "unsettled top-level
      // await" and the session simply never became ready.
      let settled = false;
      const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
      const bad = (e) => { if (!settled) { settled = true; reject(e); } };

      zipfile.on('error', bad);

      zipfile.on('entry', (entry) => {
        const entryExt = path.extname(entry.fileName).toLowerCase();

        // Skip directories and non-ROM files
        if (entry.fileName.endsWith('/') || !supportedExtensions.has(entryExt)) {
          zipfile.readEntry();
          return;
        }

        // Found a ROM - extract it.
        //
        // Read the entry RAW and inflate it ourselves. yauzl 3.2.0's internal
        // inflate pipeline stalls part-way through on Node 24 (measured:
        // 320641 of 393232 bytes, then no further 'data' and no 'end'), which
        // is what made every ROM above ~80 KB hang forever. The raw read is
        // unaffected -- all compressed bytes arrive -- and zlib inflates them
        // correctly, so we take the bytes from yauzl and do the decompression.
        zipfile.openReadStream(entry, { decompress: false }, (err, readStream) => {
          if (err) {
            bad(err);
            return;
          }

          const chunks = [];
          readStream.on('data', (chunk) => chunks.push(chunk));
          readStream.on('end', () => {
            const raw = Buffer.concat(chunks);
            // method 0 = stored, 8 = deflate. Anything else is not something
            // this archive format lets us handle without another dependency.
            let data;
            try {
              if (entry.compressionMethod === 0) data = raw;
              else if (entry.compressionMethod === 8) data = zlib.inflateRawSync(raw);
              else {
                bad(new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.fileName}`));
                return;
              }
            } catch (e) {
              bad(new Error(`Failed to decompress ${entry.fileName}: ${e.message}`));
              return;
            }
            let fileName = entry.fileName;

            // .bin is ambiguous — check magic bytes for N64 ROM signatures
            if (entryExt === '.bin' && data.length >= 4) {
              const magic = data.readUInt32BE(0);
              if (magic === 0x80371240 || // .z64 (big-endian)
                  magic === 0x40123780 || // .n64 (little-endian)
                  magic === 0x37804012) { // .v64 (byte-swapped)
                fileName = fileName.replace(/\.bin$/i, '.z64');
              }
            }

            foundRom = {
              data,
              // Use the filename inside the ZIP for extension detection
              romPath: path.join(path.dirname(zipPath), fileName),
              originalPath: zipPath,
              zipEntry: entry.fileName,
            };
            // Resolve on the data we actually have rather than waiting for a
            // 'close' that may never arrive; close() is now just cleanup.
            try { zipfile.close(); } catch { /* already closing */ }
            ok(foundRom);
          });
          readStream.on('error', bad);
        });
      });

      // Only reachable when every entry was skipped, i.e. nothing playable
      // was in the archive.
      zipfile.on('end', () => {
        bad(new Error(`No supported ROM file found in ZIP. Supported: ${[...supportedExtensions].join(', ')}`));
      });

      zipfile.on('close', () => {
        if (foundRom) ok(foundRom);
        else bad(new Error(`No supported ROM file found in ZIP. Supported: ${[...supportedExtensions].join(', ')}`));
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Check if a file path points to a ZIP archive.
 */
export function isZipFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.zip';
}
