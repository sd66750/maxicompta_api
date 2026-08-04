import mssql from 'mssql';
import { parseSqlConnectionString } from '../config/connectionString.js';
import { getActiveConnectionString, getServerConnectionString, withDatabase } from '../config/connectionStore.js';

/**
 * Cache de pools de connexion `mssql`, indexé par InitialCatalog (base).
 * La chaîne de connexion active est déchiffrée à la volée depuis le magasin.
 */
const pools = new Map<string, mssql.ConnectionPool>();

/**
 * La base PrismaSoft est en français : les triggers (onInsertEcritureLigne,
 * onUpdateEcriture…) reconstruisent une date par concaténation `jour/mois/année`
 * puis `CONVERT(datetime, …)`, ce qui suppose le format **dmy**. Or la connexion
 * Node ouvre la session en us_english (mdy) → « 16/01/2025 » interprété mois=16
 * → « conversion out-of-range ». On force donc dmy sur chaque batch (même lot,
 * pas d'aller-retour réseau supplémentaire) ; sans effet sur les SELECT.
 */
const DMY = 'SET DATEFORMAT dmy;\n';

export class ConnectionNotConfiguredError extends Error {
  constructor() {
    super("Aucune chaîne de connexion n'est configurée. Configurez-la via le formulaire de connexion.");
    this.name = 'ConnectionNotConfiguredError';
  }
}

/** Ouvre (ou récupère) le pool pour la connexion active. */
export async function getPool(): Promise<mssql.ConnectionPool> {
  const raw = await getActiveConnectionString();
  if (!raw) throw new ConnectionNotConfiguredError();

  const config = parseSqlConnectionString(raw);
  const key = `${config.server}/${config.database ?? ''}`;

  const existing = pools.get(key);
  if (existing && existing.connected) return existing;
  if (existing && existing.connecting) return existing;

  const pool = new mssql.ConnectionPool(config);
  pool.on('error', (err) => {
    console.error('[pool] Erreur de pool mssql :', err.message);
    pools.delete(key);
  });
  await pool.connect();
  pools.set(key, pool);
  return pool;
}

/** Nom de la base courante (InitialCatalog) — sert de bddSociete pour la GED. */
export async function getCurrentDatabaseName(): Promise<string | undefined> {
  const raw = await getActiveConnectionString();
  if (!raw) return undefined;
  return parseSqlConnectionString(raw).database;
}

/**
 * Découvre les sociétés = bases `PrismaSoft_%` ONLINE sur le serveur configuré.
 * Se connecte à `master` (pool dédié, mis en cache) — indépendant de la société active.
 */
export async function listSocietes(): Promise<string[]> {
  const server = await getServerConnectionString();
  if (!server) throw new ConnectionNotConfiguredError();

  const config = parseSqlConnectionString(withDatabase(server, 'master'));
  const key = `${config.server}/master`;

  let pool = pools.get(key);
  if (!pool || (!pool.connected && !pool.connecting)) {
    pool = new mssql.ConnectionPool(config);
    pool.on('error', (err) => {
      console.error('[pool:master] Erreur :', err.message);
      pools.delete(key);
    });
    await pool.connect();
    pools.set(key, pool);
  }

  const result = await pool.request().query<{ name: string }>(
    "SELECT name FROM sys.databases WHERE name LIKE 'PrismaSoft\\_%' ESCAPE '\\' AND state = 0 ORDER BY name"
  );
  return result.recordset.map((r) => r.name);
}

/** Teste une chaîne de connexion arbitraire sans la persister ni la mettre en cache. */
export async function testConnectionString(raw: string): Promise<{ ok: true; version: string; database?: string }> {
  const config = parseSqlConnectionString(raw);
  const pool = new mssql.ConnectionPool(config);
  try {
    await pool.connect();
    const result = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db');
    const row = result.recordset[0];
    return { ok: true, version: String(row?.version ?? '').split('\n')[0], database: row?.db };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

/** Exécute une requête paramétrée sur la connexion active. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value);
  }
  const result = await request.query<T>(DMY + sql);
  return result.recordset;
}

/** Fonction de requête paramétrée exécutée dans une transaction. */
export type TxQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>
) => Promise<T[]>;

/**
 * Exécute `work` dans une transaction SQL. Commit si succès, rollback sinon.
 * `work` reçoit une fonction `q` paramétrée liée à la transaction.
 */
export async function withTransaction<T>(work: (q: TxQuery) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  const q: TxQuery = async (sql, params = {}) => {
    const request = new mssql.Request(tx);
    for (const [name, value] of Object.entries(params)) request.input(name, value);
    const result = await request.query(DMY + sql);
    return result.recordset as never;
  };
  try {
    const result = await work(q);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  }
}

export { mssql };
