import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** AES-256-GCM with a fresh random 12-byte IV per call. */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

/** Returns null on any authentication or length failure; never throws key or plaintext material. */
export function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer | null {
  try {
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) return null;
    const d = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(sealed.tag);
    return Buffer.concat([d.update(sealed.ciphertext), d.final()]);
  } catch {
    return null;
  }
}
