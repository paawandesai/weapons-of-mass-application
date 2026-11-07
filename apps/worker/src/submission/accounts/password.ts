import { randomInt } from 'node:crypto';
import { PASSWORD_LENGTH } from '../constants';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 24 characters from a 62-character alphabet, uniformly (randomInt rejects biased draws). */
export function generatePassword(length: number = PASSWORD_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
