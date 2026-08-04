import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt } from './crypto.js';
import { redactConnectionString } from './connectionString.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const STORE_FILE = join(DATA_DIR, 'connections.enc.json');

/**
 * Modèle « une connexion serveur, N sociétés » :
 *   - on stocke UNE chaîne de connexion serveur (host + identifiants), chiffrée ;
 *   - les sociétés sont les bases `PrismaSoft_%` découvertes à la volée ;
 *   - `activeDatabase` = société active (Initial Catalog injecté à la connexion).
 */
interface StoredServer {
  /** Chaîne de connexion serveur chiffrée (AES-256-GCM). */
  cipher: string;
  /** Base société active (nom d'InitialCatalog). null = aucune sélectionnée. */
  activeDatabase: string | null;
  updatedAt: string;
}

/** Ancien format mono-connexion (migration). */
interface LegacyStored {
  cipher: string;
  label: string;
  updatedAt: string;
}

let cache: StoredServer | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/** Extrait l'Initial Catalog / Database d'une chaîne .NET (ou undefined). */
function extractCatalog(raw: string): string | undefined {
  const m = raw.match(/(?:initial\s+catalog|database)\s*=\s*([^;]+)/i);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
}

/**
 * Renvoie la chaîne serveur avec l'Initial Catalog forcé sur `database`
 * (remplace un éventuel catalogue existant).
 */
export function withDatabase(raw: string, database: string): string {
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^\s*(initial\s+catalog|database)\s*=/i.test(p));
  parts.push(`Initial Catalog=${database}`);
  return parts.join(';');
}

async function load(): Promise<StoredServer | null> {
  if (cache) return cache;
  if (!existsSync(STORE_FILE)) return null;
  try {
    const content = await readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(content) as StoredServer | LegacyStored;

    // Migration de l'ancien format { cipher, label } → { cipher, activeDatabase }
    if ('label' in parsed && !('activeDatabase' in parsed)) {
      let activeDatabase: string | null = null;
      try {
        activeDatabase = extractCatalog(decrypt(parsed.cipher)) ?? parsed.label ?? null;
      } catch {
        activeDatabase = parsed.label ?? null;
      }
      cache = { cipher: parsed.cipher, activeDatabase, updatedAt: parsed.updatedAt };
      await persist(cache);
      return cache;
    }

    cache = parsed as StoredServer;
    return cache;
  } catch {
    return null;
  }
}

async function persist(stored: StoredServer): Promise<void> {
  await ensureDir();
  await writeFile(STORE_FILE, JSON.stringify(stored, null, 2), 'utf8');
  cache = stored;
}

/** Chaîne de connexion serveur en clair (sans Initial Catalog forcé). Usage serveur uniquement. */
export async function getServerConnectionString(): Promise<string | null> {
  const stored = await load();
  return stored ? decrypt(stored.cipher) : null;
}

/** Société active (nom de base) ou null. */
export async function getActiveDatabase(): Promise<string | null> {
  const stored = await load();
  return stored?.activeDatabase ?? null;
}

/**
 * Chaîne de connexion effective : serveur + Initial Catalog = société active.
 * Si aucune société active, renvoie la chaîne serveur telle quelle (→ base par défaut).
 */
export async function getActiveConnectionString(): Promise<string | null> {
  const stored = await load();
  if (!stored) return null;
  const server = decrypt(stored.cipher);
  return stored.activeDatabase ? withDatabase(server, stored.activeDatabase) : server;
}

/** Statut sans secret, destiné au client. */
export async function getConnectionStatus(): Promise<{ configured: boolean; activeDatabase?: string; updatedAt?: string }> {
  const stored = await load();
  if (!stored) return { configured: false };
  return { configured: true, activeDatabase: stored.activeDatabase ?? undefined, updatedAt: stored.updatedAt };
}

/** Chiffre et persiste la chaîne de connexion serveur. Conserve la société active si compatible. */
export async function saveServerConnection(raw: string): Promise<void> {
  const previous = await load();
  const stored: StoredServer = {
    cipher: encrypt(raw),
    // On garde la société active précédente (le front la re-validera via /databases).
    activeDatabase: previous?.activeDatabase ?? null,
    updatedAt: new Date().toISOString(),
  };
  await persist(stored);
  // Ne jamais logguer la chaîne en clair.
  console.log(`[connectionStore] Connexion serveur enregistrée : ${redactConnectionString(raw)}`);
}

/** Définit la société active (base). */
export async function setActiveDatabase(database: string): Promise<void> {
  const stored = await load();
  if (!stored) throw new Error("Aucune connexion serveur configurée.");
  await persist({ ...stored, activeDatabase: database, updatedAt: new Date().toISOString() });
  console.log(`[connectionStore] Société active : ${database}`);
}
