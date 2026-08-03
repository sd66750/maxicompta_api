import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt } from './crypto.js';
import { redactConnectionString } from './connectionString.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const STORE_FILE = join(DATA_DIR, 'connections.enc.json');

interface StoredConnection {
  /** Chaîne de connexion .NET chiffrée (AES-256-GCM). */
  cipher: string;
  /** Nom lisible (InitialCatalog) pour l'UI — sans secret. */
  label: string;
  updatedAt: string;
}

let cache: StoredConnection | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function load(): Promise<StoredConnection | null> {
  if (cache) return cache;
  if (!existsSync(STORE_FILE)) return null;
  try {
    const content = await readFile(STORE_FILE, 'utf8');
    cache = JSON.parse(content) as StoredConnection;
    return cache;
  } catch {
    return null;
  }
}

/** Renvoie la chaîne de connexion en clair (usage interne serveur uniquement). */
export async function getActiveConnectionString(): Promise<string | null> {
  const stored = await load();
  if (!stored) return null;
  return decrypt(stored.cipher);
}

/** Statut sans secret, destiné au client. */
export async function getConnectionStatus(): Promise<{ configured: boolean; label?: string; updatedAt?: string }> {
  const stored = await load();
  if (!stored) return { configured: false };
  return { configured: true, label: stored.label, updatedAt: stored.updatedAt };
}

/** Chiffre et persiste la chaîne de connexion. `label` = InitialCatalog déduit. */
export async function saveConnectionString(raw: string, label: string): Promise<void> {
  await ensureDir();
  const stored: StoredConnection = {
    cipher: encrypt(raw),
    label,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(STORE_FILE, JSON.stringify(stored, null, 2), 'utf8');
  cache = stored;
  // Ne jamais logguer la chaîne en clair.
  console.log(`[connectionStore] Connexion enregistrée : ${redactConnectionString(raw)}`);
}
