import { readFileSync } from 'node:fs';
import { desktopRuntime } from './desktop-runtime';

function loadEncryptionKey(): Buffer | null {
  const desktop = desktopRuntime();
  if (desktop) return desktop.encryptionKey;
  const inline = process.env.STUDIO_ENCRYPTION_KEY;
  const file = process.env.STUDIO_ENCRYPTION_KEY_FILE;
  if (inline && file) throw new Error('Configure only one of STUDIO_ENCRYPTION_KEY and STUDIO_ENCRYPTION_KEY_FILE');
  let encoded = inline;
  if (file) {
    try { encoded = readFileSync(file, 'utf8').trim(); }
    catch { throw new Error('STUDIO_ENCRYPTION_KEY_FILE could not be read'); }
    if (!encoded) throw new Error('STUDIO_ENCRYPTION_KEY_FILE must contain a base64-encoded 32-byte key');
  }
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('The Studio encryption key must be a canonical base64-encoded 32-byte key');
  }
  return key;
}

// Loaded once at startup and shared by API-key and OAuth credential storage.
// File errors deliberately omit paths and contents from diagnostics.
export const studioEncryptionKey = loadEncryptionKey();
