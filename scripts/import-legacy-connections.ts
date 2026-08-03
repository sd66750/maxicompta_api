/**
 * Utilitaire de migration : récupère et déchiffre les profils de connexion
 * stockés par l'application WinForms legacy dans le registre Windows.
 *
 * Emplacement : HKEY_CURRENT_USER\6DF2E109-808A-43E5-9D46-51B6322EC0F6
 *   - le NOM de chaque sous-clé = libellé chiffré (DES/Base64)
 *   - valeurs : type, cle (en clair) ; connexionStringInt / connexionStringExt
 *     (chaîne de connexion, éventuellement chiffrée)
 *
 * Chiffrement legacy (cf. PrismaSoft.Utils/crypt.cs) :
 *   DES-CBC, clé = IV = octets ASCII de "\{0__o}/", sortie Base64.
 *
 * Usage (depuis PrismaSoft.Compta.Web/server) :
 *   npx tsx scripts/import-legacy-connections.ts            # liste les profils (mots de passe masqués)
 *   npx tsx scripts/import-legacy-connections.ts --save 1   # enregistre le profil n°1 (chaîne INTERNE) dans le magasin chiffré
 *   npx tsx scripts/import-legacy-connections.ts --save 1 --ext   # idem, chaîne EXTERIEUR
 *
 * Tout reste local : le script n'envoie rien sur le réseau. En mode --save,
 * la chaîne (avec identifiants) est écrite directement chiffrée dans
 * data/connections.enc.json — elle n'apparaît jamais en clair à l'écran.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { saveConnectionString } from '../src/config/connectionStore.js';
import { testConnectionString } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DES simple n'est plus fourni par OpenSSL 3 (Node ≥ 17) sans « legacy provider ».
// On utilise donc une implémentation DES pure JS pour rester compatible.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const des: any = require('des.js');

const REG_ROOT = String.raw`HKCU\6DF2E109-808A-43E5-9D46-51B6322EC0F6`;
const DES_KEY = Buffer.from('\\{0__o}/', 'ascii'); // 8 octets = clé DES 64 bits

/**
 * Déchiffre une chaîne Base64 chiffrée en DES-CBC + PKCS7 (algorithme legacy,
 * cf. PrismaSoft.Utils/crypt.cs). Renvoie null si l'entrée n'est pas déchiffrable.
 */
function decryptLegacy(value: string): string | null {
  try {
    const data = Buffer.from(value, 'base64');
    if (data.length === 0 || data.length % 8 !== 0) return null;
    const cipher = des.CBC.instantiate(des.DES).create({ type: 'decrypt', key: DES_KEY, iv: DES_KEY });
    const out = Buffer.from(cipher.update(data).concat(cipher.final()));
    // Retrait du padding PKCS7.
    const pad = out[out.length - 1];
    const end = pad >= 1 && pad <= 8 ? out.length - pad : out.length;
    const text = out.subarray(0, end).toString('utf8');
    // Rejette les résultats manifestement binaires (mauvaise clé) au profit de null.
    // eslint-disable-next-line no-control-regex
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Renvoie une chaîne de connexion lisible, qu'elle soit chiffrée ou déjà en clair. */
function resolveConnectionString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/data source=/i.test(raw)) return raw; // déjà en clair
  const dec = decryptLegacy(raw);
  return dec && /data source=/i.test(dec) ? dec : raw;
}

function reg(...args: string[]): string {
  try {
    return execFileSync('reg', args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** Masque le mot de passe pour l'affichage. */
function redact(cs: string): string {
  return cs.replace(/(password|pwd)\s*=\s*[^;]*/gi, '$1=********');
}

interface RegKey {
  path: string;
  values: Record<string, string>;
}

/**
 * Parse la sortie de `reg query <clé> /s` (dump récursif) en une liste de clés
 * avec leurs valeurs, quelle que soit la profondeur d'imbrication.
 */
function parseRecursive(output: string): RegKey[] {
  const keys: RegKey[] = [];
  let current: RegKey | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim()) && !/\s+REG_/.test(line)) {
      current = { path: line.trim(), values: {} };
      keys.push(current);
      continue;
    }
    // format : "    NomValeur    REG_SZ    donnée"
    const m = line.match(/^\s+(\S.*?)\s+REG_\w+\s+(.*)$/);
    if (m && current) current.values[m[1].trim()] = m[2];
  }
  return keys;
}

interface Profil {
  index: number;
  label: string;
  type: string;
  csInt?: string;
  csExt?: string;
}

/** Déduit l'InitialCatalog d'une chaîne (pour libeller le profil). */
function extractCatalog(cs: string): string {
  const m = cs.match(/initial\s+catalog\s*=\s*([^;]+)/i) ?? cs.match(/database\s*=\s*([^;]+)/i);
  return m ? m[1].trim() : 'base SQL Server';
}

function lireProfils(debug = false): Profil[] {
  const dump = reg('query', REG_ROOT, '/s');
  if (!dump) {
    console.error(`Clé introuvable ou illisible : ${REG_ROOT}`);
    console.error('Aucun profil de connexion legacy dans le registre (ou droits insuffisants).');
    process.exit(1);
  }

  const keys = parseRecursive(dump);

  // Chemin racine tel qu'affiché par reg.exe (HKCU -> HKEY_CURRENT_USER).
  const rootFull = 'HKEY_CURRENT_USER\\' + REG_ROOT.slice('HKCU\\'.length);
  const segmentsAfterRoot = (path: string): string[] =>
    path.length > rootFull.length ? path.slice(rootFull.length).split('\\').filter(Boolean) : [];

  if (debug) {
    // Structure : chemins + noms de sous-clés déchiffrés (les DONNÉES ne sont pas écrites).
    const lines: string[] = [`Dump structurel de ${REG_ROOT}`, `${keys.length} clé(s)`, ''];
    for (const k of keys) {
      const segs = segmentsAfterRoot(k.path);
      const decoded = segs.map((s) => decryptLegacy(s) ?? `‹${s}›`).join(' / ');
      lines.push(`${'  '.repeat(segs.length)}${segs[segs.length - 1] ?? '(racine)'}   =>   ${decoded || '(racine)'}`);
    }
    const out = lines.join('\n');
    console.log('\n' + out + '\n');
    const file = join(__dirname, '_registry-debug.txt');
    writeFileSync(file, out, 'utf8');
    console.log(`[debug] Structure (noms déchiffrés, sans données) écrite dans ${file}.`);
  }

  // Structure : ROOT \ <profil chiffré> \ <champ chiffré> = (valeur par défaut chiffrée)
  const profileKeys = keys.filter((k) => segmentsAfterRoot(k.path).length === 1);
  if (profileKeys.length === 0) {
    console.error('Aucun profil trouvé sous la clé racine.');
    process.exit(1);
  }

  const profils: Profil[] = [];
  profileKeys.forEach((profKey, i) => {
    const profSeg = segmentsAfterRoot(profKey.path)[0];
    // Champs = sous-clés enfants directes ; nom = déchiffré, donnée = valeur par défaut déchiffrée.
    const champs: Record<string, string> = {};
    for (const k of keys) {
      const segs = segmentsAfterRoot(k.path);
      if (segs.length !== 2 || segs[0] !== profSeg) continue;
      const fieldName = (decryptLegacy(segs[1]) ?? '').trim();
      if (!fieldName) continue;
      // La donnée est la valeur "(par défaut)" — nom localisé selon Windows, on prend donc la 1re valeur.
      const rawData = Object.values(k.values).find((v) => v && !/valeur non définie|value not set/i.test(v));
      const data = rawData ? (decryptLegacy(rawData) ?? rawData) : '';
      champs[fieldName.toLowerCase()] = data;
    }
    profils.push({
      index: i + 1,
      label: (decryptLegacy(profSeg) ?? profSeg).replace(/-EXT|STANDARD/g, '').trim() || `Profil ${i + 1}`,
      type: champs['type'] || '-',
      csInt: resolveConnectionString(champs['connexionstringint']),
      csExt: resolveConnectionString(champs['connexionstringext']),
    });
  });

  return profils;
}

async function main() {
  const args = process.argv.slice(2);
  const saveIdx = args.includes('--save') ? Number(args[args.indexOf('--save') + 1]) : null;
  const useExt = args.includes('--ext');
  const debug = args.includes('--debug');
  const reveal = args.includes('--reveal'); // affiche la chaîne COMPLÈTE, mot de passe en clair

  const profils = lireProfils(debug);

  if (saveIdx == null) {
    // Mode liste. Par défaut le mot de passe est masqué ; --reveal l'affiche en clair.
    const show = (cs: string) => (reveal ? cs : redact(cs));
    console.log(`\n${profils.length} profil(s) de connexion trouvé(s) :\n`);
    for (const p of profils) {
      console.log(`── Profil ${p.index} : ${p.label}   [type: ${p.type}]`);
      if (p.csInt) console.log(`   INTERNE   : ${show(p.csInt)}`);
      if (p.csExt) console.log(`   EXTERIEUR : ${show(p.csExt)}`);
      console.log('');
    }
    if (reveal) {
      console.log('⚠  Mot de passe affiché en clair (--reveal). Ne partagez pas cette sortie.\n');
    } else {
      console.log('→ Chaîne complète (mot de passe en clair) : ajoutez --reveal');
      console.log('→ Enregistrer un profil dans la nouvelle app (chiffré, sans afficher le mot de passe) :');
      console.log('    npx tsx scripts/import-legacy-connections.ts --save <n> [--ext]\n');
    }
    return;
  }

  // Mode enregistrement : écrit la chaîne chiffrée dans le magasin, sans jamais l'afficher en clair.
  const profil = profils.find((p) => p.index === saveIdx);
  if (!profil) {
    console.error(`Profil ${saveIdx} introuvable.`);
    process.exit(1);
  }
  const cs = useExt ? profil.csExt : profil.csInt;
  if (!cs) {
    console.error(`Le profil ${saveIdx} n'a pas de chaîne ${useExt ? 'EXTERIEUR' : 'INTERNE'}.`);
    process.exit(1);
  }

  process.stdout.write(`Test de la connexion « ${profil.label} »... `);
  try {
    const res = await testConnectionString(cs);
    console.log(`OK (base : ${res.database ?? '?'})`);
  } catch (err) {
    console.log('ÉCHEC');
    console.error(`  ${err instanceof Error ? err.message : err}`);
    console.error('  Enregistrement annulé.');
    process.exit(1);
  }

  await saveConnectionString(cs, extractCatalog(cs));
  console.log(`✓ Profil enregistré (chiffré) dans data/connections.enc.json. Vous pouvez vous connecter dans l'application.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
