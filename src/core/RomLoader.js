import fs from 'fs/promises';
import path from 'path';
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
  return {
    data,
    romPath: inputPath,
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

      zipfile.on('error', reject);

      zipfile.on('entry', (entry) => {
        const entryExt = path.extname(entry.fileName).toLowerCase();

        // Skip directories and non-ROM files
        if (entry.fileName.endsWith('/') || !supportedExtensions.has(entryExt)) {
          zipfile.readEntry();
          return;
        }

        // Found a ROM - extract it
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) {
            reject(err);
            return;
          }

          const chunks = [];
          readStream.on('data', (chunk) => chunks.push(chunk));
          readStream.on('end', () => {
            foundRom = {
              data: Buffer.concat(chunks),
              // Use the filename inside the ZIP for extension detection
              romPath: path.join(path.dirname(zipPath), entry.fileName),
              originalPath: zipPath,
              zipEntry: entry.fileName,
            };
            zipfile.close();
          });
          readStream.on('error', reject);
        });
      });

      zipfile.on('close', () => {
        if (foundRom) {
          resolve(foundRom);
        } else {
          reject(new Error(`No supported ROM file found in ZIP. Supported: ${[...supportedExtensions].join(', ')}`));
        }
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
