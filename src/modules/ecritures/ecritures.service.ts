import { query, withTransaction, type TxQuery } from '../../db/pool.js';
import { HttpError } from '../../http/helpers.js';

export interface LigneInput {
  comptePCClient: string;
  libelle?: string | null;
  debit?: number | null;
  credit?: number | null;
  lettrage?: string | null;
  idSection?: number | null;
  idNature?: number | null;
}

export interface EcritureInput {
  id?: number | null; // null / <=0 => nouvelle écriture
  idClient: number;
  codeJournal: string;
  idPeriode: number;
  jour: number;
  piece?: string | null;
  lignes: LigneInput[];
}

interface NormalizedLigne {
  comptePCClient: string;
  libelle: string | null;
  montant: number;
  sens: -1 | 1; // -1 = débit, +1 = crédit (convention legacy)
  debit: number;
  credit: number;
  lettrage: string | null;
  idSection: number | null;
  idNature: number | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Date d'une écriture = mois de la période + jour, construite à **midi UTC**.
 * Le driver mssql envoie les dates en UTC : construire en heure locale ferait
 * basculer le jour 1 sur le mois précédent (ex. UTC+1 → 01/01 devient 31/12 à
 * 23:00Z), et `CONVERT(date, …)` côté SQL verrait alors le mauvais mois — ce qui
 * cassait le contrôle de fermeture de période. On fige donc le jour calendaire
 * en UTC (midi, pour rester insensible aux décalages ±12 h).
 */
export function ecritureDate(periode: string | Date, jour: number): Date {
  const p = periode instanceof Date ? periode : new Date(periode);
  return new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), Math.max(1, jour), 12, 0, 0));
}

/** Normalise une ligne : montant absolu + sens (-1 débit / +1 crédit). */
function normalizeLigne(l: LigneInput): NormalizedLigne | null {
  const debit = round2(Number(l.debit ?? 0));
  const credit = round2(Number(l.credit ?? 0));
  // Ligne vide (aucun compte, aucun montant) => ignorée
  if (!l.comptePCClient && debit === 0 && credit === 0) return null;
  const ana = { idSection: l.idSection ?? null, idNature: l.idNature ?? null };
  if (debit !== 0) {
    return { comptePCClient: l.comptePCClient, libelle: l.libelle ?? null, montant: debit, sens: -1, debit, credit: 0, lettrage: l.lettrage ?? null, ...ana };
  }
  return { comptePCClient: l.comptePCClient, libelle: l.libelle ?? null, montant: credit, sens: 1, debit: 0, credit, lettrage: l.lettrage ?? null, ...ana };
}

/**
 * Vérifie l'autorisation d'écriture (période non fermée pour ce journal) via la
 * procédure stockée legacy `prismaCompta_isAutoriseEcriture`. C'est une PROCÉDURE
 * (pas une fonction scalaire) : on l'EXÉCUTE et on lit la 1re colonne de son
 * SELECT (bit : 1 = autorisé, 0 = période fermée). En cas d'absence/erreur de la
 * procédure, on considère l'écriture NON autorisée (fail-closed) pour ne jamais
 * contourner silencieusement une fermeture de période.
 */
export async function isAutoriseEcriture(idClient: number, codeJournal: string, date: Date): Promise<boolean> {
  const rows = await query<Record<string, unknown>>(
    `EXEC prismaCompta_isAutoriseEcriture @dateOperation = @date, @journal = @codeJournal, @idExerciceComptable = @idClient`,
    { date, codeJournal, idClient }
  );
  const v = rows[0] ? Object.values(rows[0])[0] : undefined;
  return v === undefined || v === null ? false : Boolean(v);
}

/** Génère le prochain numéro de pièce : codeJournal + YYYYMMDD + NNN. */
async function nextPiece(q: TxQuery, idClient: number, codeJournal: string, date: Date): Promise<string> {
  // date est construite à midi UTC (cf. ecritureDate) → composantes UTC.
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const prefix = `${codeJournal}${y}${m}${d}`;
  const rows = await q<{ next: number }>(
    `SELECT ISNULL(MAX(TRY_CAST(RIGHT(piece, 3) AS INT)), 0) + 1 AS next
       FROM prismaCompta_ecriture
      WHERE idClient = @idClient AND piece LIKE @prefix + '%'`,
    { idClient, prefix }
  );
  const seq = String(rows[0]?.next ?? 1).padStart(3, '0');
  return `${prefix}${seq}`;
}

async function getPeriodeDate(idPeriode: number): Promise<Date> {
  const rows = await query<{ periode: string }>(
    `SELECT periode FROM prismaCompta_periode WHERE id = @idPeriode`,
    { idPeriode }
  );
  if (!rows[0]) throw new HttpError(400, 'Période introuvable.');
  return new Date(rows[0].periode);
}

/**
 * Enregistre une écriture (en-tête + lignes) dans une seule transaction SQL.
 * Applique les contrôles métier : équilibrage, comptes non nuls, compte banque
 * du journal présent, période ouverte, n° de pièce automatique.
 */
export async function saveEcriture(input: EcritureInput): Promise<{ id: number; piece: string }> {
  const lignes = input.lignes.map(normalizeLigne).filter((l): l is NormalizedLigne => l !== null);

  if (lignes.length === 0) {
    throw new HttpError(400, 'Aucune ligne à enregistrer.');
  }
  // Comptes non nuls
  const sansCompte = lignes.find((l) => !l.comptePCClient || l.comptePCClient.trim() === '');
  if (sansCompte) {
    throw new HttpError(400, 'Chaque ligne doit référencer un compte.');
  }
  // Équilibrage : somme(crédit) - somme(débit) = 0
  const totalDebit = round2(lignes.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lignes.reduce((s, l) => s + l.credit, 0));
  if (round2(totalCredit - totalDebit) !== 0) {
    throw new HttpError(400, `Écriture déséquilibrée : débit = ${totalDebit}, crédit = ${totalCredit}.`);
  }

  // Compte banque rattaché au journal (si présent) doit être mouvementé
  const journalRows = await query<{ compteBanqueRattache: string | null; typeJournal: string | null }>(
    `SELECT compteBanqueRattache, typeJournal FROM prismaCompta_journal WHERE code = @code AND idClient = @idClient`,
    { code: input.codeJournal, idClient: input.idClient }
  );
  if (!journalRows[0]) throw new HttpError(400, `Journal « ${input.codeJournal} » introuvable.`);
  const compteBanque = journalRows[0].compteBanqueRattache?.trim();
  const typeJournal = journalRows[0].typeJournal?.trim();
  if (compteBanque && !lignes.some((l) => l.comptePCClient.trim() === compteBanque)) {
    throw new HttpError(400, `Le journal exige une ligne sur le compte banque « ${compteBanque} ».`);
  }
  // Comptes de trésorerie (classe 5) interdits par défaut ; seuls les journaux
  // d'à-nouveau/import (AN, IMP) les autorisent tous, et un journal de banque
  // autorise uniquement son compte rattaché (dérivé du filtre du plan comptable
  // dans Ecriture.cs, élargi à toute la classe 5).
  if (typeJournal !== 'AN' && typeJournal !== 'IMP') {
    const intrus = lignes.find((l) => {
      const c = l.comptePCClient.trim();
      return c !== compteBanque && c.startsWith('5');
    });
    if (intrus) {
      throw new HttpError(
        400,
        `Compte de trésorerie « ${intrus.comptePCClient.trim()} » (classe 5) non autorisé sur le journal « ${input.codeJournal} ».`
      );
    }
  }

  // Date de l'écriture = mois de la période + jour (midi UTC, cf. ecritureDate)
  const periodeDate = await getPeriodeDate(input.idPeriode);
  const dateEcriture = ecritureDate(periodeDate, input.jour);

  // Période ouverte ?
  const autorise = await isAutoriseEcriture(input.idClient, input.codeJournal, dateEcriture);
  if (!autorise) {
    throw new HttpError(409, 'Période fermée : saisie non autorisée sur ce journal à cette date.');
  }

  return withTransaction(async (q) => {
    let ecritureId = input.id && input.id > 0 ? input.id : 0;
    let piece = (input.piece ?? '').trim();
    const isNew = ecritureId === 0;

    if (!piece || piece.toUpperCase() === '[AUTOMATIQUE]') {
      piece = await nextPiece(q, input.idClient, input.codeJournal, dateEcriture);
    }

    if (isNew) {
      // SCOPE_IDENTITY plutôt qu'OUTPUT INSERTED : la table prismaCompta_ecriture
      // porte un trigger, et SQL Server interdit OUTPUT sans INTO dans ce cas.
      const inserted = await q<{ id: number }>(
        `INSERT INTO prismaCompta_ecriture (jour, piece, codeJournal, idClient, idPeriode, dateEcheance)
         VALUES (@jour, @piece, @codeJournal, @idClient, @idPeriode, @dateEcheance);
         SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`,
        {
          jour: String(input.jour),
          piece,
          codeJournal: input.codeJournal,
          idClient: input.idClient,
          idPeriode: input.idPeriode,
          dateEcheance: dateEcriture,
        }
      );
      ecritureId = inserted[0].id;
    } else {
      await q(
        `UPDATE prismaCompta_ecriture
            SET jour = @jour, piece = @piece, codeJournal = @codeJournal,
                idPeriode = @idPeriode, dateEcheance = @dateEcheance
          WHERE id = @id AND idClient = @idClient`,
        {
          id: ecritureId,
          jour: String(input.jour),
          piece,
          codeJournal: input.codeJournal,
          idPeriode: input.idPeriode,
          dateEcheance: dateEcriture,
          idClient: input.idClient,
        }
      );
      // Remplace les lignes existantes
      await q(`DELETE FROM prismaCompta_ecritureLigne WHERE idEcriture = @id`, { id: ecritureId });
    }

    // Insertion des lignes (table physique prismaCompta_ecritureLigne)
    for (const l of lignes) {
      await q(
        `INSERT INTO prismaCompta_ecritureLigne
           (libelle, montant, sens, lettrage, idEcriture, comptePCClient, importation, isLigneCloture,
            idSectionAnalytiqueLigne, idNatureAnalytiqueLigne)
         VALUES (@libelle, @montant, @sens, @lettrage, @idEcriture, @compte, 0, 0, @idSection, @idNature)`,
        {
          libelle: l.libelle,
          montant: l.montant,
          sens: l.sens,
          lettrage: l.lettrage,
          idEcriture: ecritureId,
          compte: l.comptePCClient,
          idSection: l.idSection,
          idNature: l.idNature,
        }
      );
    }

    return { id: ecritureId, piece };
  });
}
