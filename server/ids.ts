import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** Short, prefixed ids (50 random bits). */
export function newId(prefix: string): string {
  let s = ''
  for (const b of randomBytes(10)) s += ALPHABET[b & 31]
  return `${prefix}_${s}`
}
