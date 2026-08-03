import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';

/**
 * Chiffrement symétrique AES-256-GCM pour les secrets stockés au repos
 * (notamment la chaîne de connexion SQL Server).
 *
 * La clé est dérivée de PRISMA_CONFIG_KEY par SHA-256 afin d'accepter
 * une passphrase de longueur arbitraire tout en obtenant 32 octets.
 */
const KEY = createHash('sha256').update(env.configKey).digest();

const IV_LENGTH = 12; // recommandé pour GCM

export function encrypt(plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // format : iv.authTag.ciphertext (base64)
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Charge chiffrée invalide.');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
