import { Router } from 'express';
import { z } from 'zod';
import iconv from 'iconv-lite';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const fecRouter = Router();

/**
 * Export FEC (Fichier des Écritures Comptables, art. A47 A-1 du LPF).
 * S'appuie sur la procédure existante prismaCompta_ExportFEC (mapping des 18
 * colonnes, comptes tiers 411/401, dates de lettrage…). Format identique à
 * l'export PrismaSoft : séparateur pipe, montants à 4 décimales (virgule),
 * dates AAAAMMJJ, libellés en MAJUSCULES avec « . » remplacé par « , »,
 * encodage ISO-8859-15, nom SIRENFECAAAAMMJJ.txt.
 */

const SEP = '|';

const FEC_COLS = [
  'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib',
  'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
  'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
] as const;
const MONTANT_COLS = new Set(['Debit', 'Credit', 'Montantdevise']);

/** Retire le séparateur et les sauts de ligne (dans tous les modes). */
const sansSeparateur = (v: unknown) => (v == null ? '' : String(v).replace(/[\t\r\n|]+/g, ' '));
/** Champ texte à l'identique de PrismaSoft : MAJUSCULES et « . » → « , ». */
const cleanExact = (v: unknown) => sansSeparateur(v).toUpperCase().replace(/\./g, ',');
/** Champ texte « propre » : casse d'origine conservée, points conservés, espaces superflus supprimés. */
const cleanPropre = (v: unknown) => sansSeparateur(v).trim();
/** Montant → chaîne à 4 décimales, séparateur virgule (vide si null). */
const montant = (v: unknown) => (v == null || v === '' ? '' : Number(v).toFixed(4).replace('.', ','));

const paramsSchema = z.object({
  idClient: z.coerce.number().int(),
  dateDebut: z.string().min(8),
  dateFin: z.string().min(8),
  // 'prismasoft' (défaut, identique au legacy) ou 'propre' (libellés lisibles).
  libelles: z.enum(['prismasoft', 'propre']).optional().default('prismasoft'),
});

/** Base du nom de fichier FEC : SIRENFECAAAAMMJJ (clôture = fin d'exercice). */
async function fecFileBase(idClient: number): Promise<string> {
  const cli = await query<{ numSiret: string | null; exerciceFin: string }>(
    `SELECT numSiret, exerciceFin FROM prismaCompta_client WHERE id = @idClient`,
    { idClient }
  );
  if (!cli[0]) throw new HttpError(404, 'Exercice introuvable.');
  const siren = (cli[0].numSiret ?? '').replace(/\D/g, '').slice(0, 9) || 'SIREN';
  const c = new Date(cli[0].exerciceFin);
  const yyyymmdd = `${c.getUTCFullYear()}${String(c.getUTCMonth() + 1).padStart(2, '0')}${String(c.getUTCDate()).padStart(2, '0')}`;
  return `${siren}FEC${yyyymmdd}`;
}

async function buildFec(idClient: number, dateDebut: string, dateFin: string, libelles: 'prismasoft' | 'propre') {
  const clean = libelles === 'propre' ? cleanPropre : cleanExact;
  const base = await fecFileBase(idClient);

  const rows = await query<Record<string, unknown>>(
    `EXEC prismaCompta_ExportFEC @idExercice = @idClient, @dateDebut = @dateDebut, @date = @dateFin`,
    { idClient, dateDebut, dateFin }
  );

  const lignes = rows.map((r) =>
    FEC_COLS.map((c) => (MONTANT_COLS.has(c) ? montant(r[c]) : clean(r[c]))).join(SEP)
  );
  // En-tête non transformé (noms de colonnes officiels), puis les lignes.
  const texte = [FEC_COLS.join(SEP), ...lignes].join('\r\n') + '\r\n';
  const content = iconv.encode(texte, 'ISO-8859-15');

  const totalDebit = rows.reduce((s, r) => s + (Number(r.Debit) || 0), 0);
  const totalCredit = rows.reduce((s, r) => s + (Number(r.Credit) || 0), 0);

  return { fileName: `${base}.txt`, content, nbLignes: rows.length, totalDebit, totalCredit };
}

// Descriptif des zones accompagnant le FEC. Reproduit à l'identique le fichier
// PrismaSoft, y compris ses espaces/tabulations de fin incohérents sur certains
// noms et types de champ (\t = tabulation finale).
const A = 'Alphanumérique';
const AT = 'Alphanumérique\t';
const FEC_ZONES: [string, string, string][] = [
  ["Le code journal de l'écriture comptable ", 'JournalCode', A],
  ["Le libellé journal de l'écriture comptable ", 'JournalLib', AT],
  ["Le numéro sur une séquence continue de l'écriture comptable", 'EcritureNum', AT],
  ["La date de comptabilisation de l'écriture comptable ", 'EcritureDate', 'Date'],
  ['Le numéro de compte, dont les trois premiers caractères doivent correspondre à des chiffres respectant les normes du plan comptable français ', 'CompteNum', AT],
  ['Le libellé de compte, conformément à la nomenclature du plan comptable français', 'CompteLib', AT],
  ['Le numéro de compte auxiliaire (à blanc si non utilisé)', 'CompAuxNum', AT],
  ['Le libellé de compte auxiliaire (à blanc si non utilisé)', 'CompAuxLib', AT],
  ['La référence de la pièce justificative', 'PieceRef', AT],
  ['La date de la pièce justificative ', 'PieceDate', 'Date'],
  ["Le libellé de l'écriture comptable", 'EcritureLib', AT],
  ['Le montant au débit ', 'Debit', 'Numérique'],
  ['Le montant au crédit', 'Credit', 'Numérique '],
  ["Le lettrage de l'écriture comptable (à blanc si non utilisé)", 'EcritureLet ', AT],
  ['La date de lettrage (à blanc si non utilisé)', 'DateLet ', 'Date'],
  ["La date de validation de l'écriture comptable", 'ValidDate', 'Date'],
  ['Le montant en devise (à blanc si non utilisé)', 'Montantdevise ', 'Numérique '],
  ["L'identifiant de la devise (à blanc si non utilisé) ", 'Idevise ', A],
];

function descriptionText(): string {
  const entete = [
    'I   - Type de structure : La longueur des enregistrements est fixe, avec séparateur de zone ',
    "II  - Caractère séparateur de zone : '|'",
    "III - Séparateur d'enregistrement :  Retour chariot et fin de ligne",
    'IV  - Norme ISO 8859-15',
    'V   - Liste des zones:',
  ];
  const zones = FEC_ZONES.flatMap(([desc, nom, type], i) => [
    `\t${i + 1}. ${desc}`,
    `\t\tNom du champ :   ${nom}`,
    `\t\tType  de champ : ${type}`,
  ]);
  // Pas de saut de ligne final (comme le fichier PrismaSoft).
  return [...entete, ...zones].join('\r\n');
}

async function buildDescription(idClient: number) {
  const base = await fecFileBase(idClient);
  return { fileName: `${base}DESCRIPTION.txt`, content: Buffer.from(descriptionText(), 'utf-8') };
}

/** GET /api/fec/apercu — statistiques avant export (nb lignes, équilibre, nom du fichier). */
fecRouter.get(
  '/apercu',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, dateDebut, dateFin, libelles } = paramsSchema.parse(req.query);
    const { fileName, nbLignes, totalDebit, totalCredit } = await buildFec(idClient, dateDebut, dateFin, libelles);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    res.json({
      fileName,
      nbLignes,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
      equilibre: round2(totalDebit - totalCredit) === 0,
    });
  })
);

/** GET /api/fec/export — télécharge le fichier FEC (tabulé). */
fecRouter.get(
  '/export',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, dateDebut, dateFin, libelles } = paramsSchema.parse(req.query);
    const { fileName, content } = await buildFec(idClient, dateDebut, dateFin, libelles);
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-15');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(content);
  })
);

/** GET /api/fec/description — télécharge le fichier descriptif accompagnant le FEC. */
fecRouter.get(
  '/description',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const { fileName, content } = await buildDescription(idClient);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(content);
  })
);
