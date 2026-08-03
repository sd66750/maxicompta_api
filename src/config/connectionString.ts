import type { config as MssqlConfig } from 'mssql';

/**
 * Convertit une chaîne de connexion .NET (System.Data.SqlClient) — telle
 * qu'utilisée par l'application WinForms d'origine — en configuration `mssql`.
 *
 * Exemple d'entrée :
 *   Data Source=preprodsql.prismasoft.fr,9901;Initial Catalog=PrismaSoft_BASE;User ID=sa;Password=xxx;Connect Timeout=120
 *   Data Source=127.0.0.1;Initial Catalog=CASAS;Integrated Security=True
 */
export function parseSqlConnectionString(raw: string): MssqlConfig {
  const parts = raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);

  const map = new Map<string, string>();
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    let value = part.slice(idx + 1).trim();
    // retirer d'éventuels guillemets simples/doubles (le legacy en utilise)
    value = value.replace(/^['"]|['"]$/g, '');
    map.set(key, value);
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = map.get(k.toLowerCase());
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const dataSource = get('data source', 'server', 'address', 'addr', 'network address');
  if (!dataSource) {
    throw new Error("Chaîne de connexion invalide : 'Data Source' (serveur) est requis.");
  }

  // Data Source peut être "host,port" ou "host\\instance" ou "host"
  let server = dataSource;
  let port: number | undefined;
  let instanceName: string | undefined;

  const commaIdx = dataSource.lastIndexOf(',');
  if (commaIdx !== -1) {
    server = dataSource.slice(0, commaIdx).trim();
    const portStr = dataSource.slice(commaIdx + 1).trim();
    const parsed = Number(portStr);
    if (!Number.isNaN(parsed)) port = parsed;
  }
  const backslashIdx = server.indexOf('\\');
  if (backslashIdx !== -1) {
    instanceName = server.slice(backslashIdx + 1).trim();
    server = server.slice(0, backslashIdx).trim();
  }

  const database = get('initial catalog', 'database');
  const user = get('user id', 'uid', 'user');
  const password = get('password', 'pwd');
  const integrated = get('integrated security', 'trusted_connection');
  const useIntegrated = integrated
    ? ['true', 'sspi', 'yes'].includes(integrated.toLowerCase())
    : false;

  const connectTimeout = get('connect timeout', 'connection timeout', 'timeout');
  const encrypt = get('encrypt');
  const trustCert = get('trustservercertificate');

  const config: MssqlConfig = {
    server,
    database,
    user,
    password,
    port,
    connectionTimeout: connectTimeout ? Number(connectTimeout) * 1000 : 30000,
    requestTimeout: 60000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      instanceName,
      // Par défaut on ne force pas le chiffrement (bases internes/legacy),
      // mais on respecte la chaîne si elle le demande.
      encrypt: encrypt ? encrypt.toLowerCase() === 'true' : false,
      trustServerCertificate: trustCert ? trustCert.toLowerCase() === 'true' : true,
      enableArithAbort: true,
    },
  };

  if (useIntegrated) {
    // L'authentification Windows intégrée nécessite msnodesqlv8 ; non prise en
    // charge par le driver tedious par défaut. On le signale clairement.
    throw new Error(
      "L'authentification Windows intégrée (Integrated Security=True) n'est pas prise en charge par ce backend. " +
        'Fournissez un identifiant SQL (User ID / Password).'
    );
  }

  if (!config.user || !config.password) {
    throw new Error("Chaîne de connexion invalide : 'User ID' et 'Password' sont requis (authentification SQL).");
  }

  return config;
}

/** Masque le mot de passe pour l'affichage/log (jamais renvoyer le secret au client). */
export function redactConnectionString(raw: string): string {
  return raw.replace(/(password|pwd)\s*=\s*[^;]*/gi, '$1=********');
}
