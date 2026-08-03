import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query, withTransaction, type TxQuery } from '../../db/pool.js';
import { nextLettrageCode } from './lettrageCode.js';

export const lettrageRouter = Router();

const idClientQuery = z.object({ idClient: z.coerce.number().int() });

/**
 * Jointure d'identification du compte tiers auxiliaire (reprise du legacy) :
 * ISNULL(idTiersCentralisateur, 411%->1, 401%->2, sinon 0) = idCentralisateur.
 */
const JOIN_PLAN = `
  INNER JOIN prismaCompta_planComptable p
    ON l.comptePCClient = p.compte
   AND ISNULL(l.idTiersCentralisateur,
         CASE WHEN l.comptePCClient LIKE '411%' THEN 1
              WHEN l.comptePCClient LIKE '401%' THEN 2 ELSE 0 END) = p.idCentralisateur
   AND (l.idClientLigne = p.idClient OR p.idClient IS NULL)`;

/**
 * GET /api/lettrage/comptes?idClient=
 * Comptes lettrables (tiers/bilan) = comptes mouvementés hors 44x, 6x, 7x
 * (règle GestionLettrage), avec le nombre de lignes non lettrées.
 */
lettrageRouter.get(
  '/comptes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const rows = await query(
      `SELECT p.displayMember AS compte,
              MAX(p.libelle)  AS libelle,
              SUM(CASE WHEN NULLIF(l.lettrage,'') IS NULL THEN 1 ELSE 0 END) AS nonLettrees,
              COUNT(*) AS total
         FROM prismaCompta_ecritureLigne l
         ${JOIN_PLAN}
        WHERE l.idClientLigne = @idClient
          AND p.displayMember NOT LIKE '44%'
          AND p.displayMember NOT LIKE '6%'
          AND p.displayMember NOT LIKE '7%'
        GROUP BY p.displayMember
        ORDER BY p.displayMember`,
      { idClient }
    );
    res.json(rows);
  })
);

interface LigneRow {
  idLigne: number;
  id: number;
  dateEcriture: string;
  codeJournal: string;
  piece: string;
  libelle: string;
  debit: number | null;
  credit: number | null;
  lettrage: string | null;
}

/**
 * GET /api/lettrage/lignes?idClient=&compte=&filtre=toutes|lettrees|nonlettrees
 * Lignes d'un compte tiers pour le lettrage.
 */
lettrageRouter.get(
  '/lignes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { compte, filtre } = z
      .object({
        compte: z.string().min(1),
        filtre: z.enum(['toutes', 'lettrees', 'nonlettrees']).default('toutes'),
      })
      .parse(req.query);

    const filtreSql =
      filtre === 'lettrees'
        ? `AND NULLIF(l.lettrage,'') IS NOT NULL`
        : filtre === 'nonlettrees'
          ? `AND NULLIF(l.lettrage,'') IS NULL`
          : '';

    const rows = await query<LigneRow>(
      `SELECT l.id                 AS idLigne,
              l.idEcriture         AS id,
              l.dateEcritureLigne  AS dateEcriture,
              l.codeJournalLigne   AS codeJournal,
              l.pieceLigne         AS piece,
              l.libelle,
              CASE WHEN l.sens = -1 THEN l.montant END AS debit,
              CASE WHEN l.sens =  1 THEN l.montant END AS credit,
              l.lettrage
         FROM prismaCompta_ecritureLigne l
         ${JOIN_PLAN}
        WHERE l.idClientLigne = @idClient
          AND p.displayMember = @compte
          ${filtreSql}
        ORDER BY l.lettrage, l.dateEcritureLigne, l.id`,
      { idClient, compte }
    );
    res.json(rows);
  })
);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Récupère les lignes (montant/sens/compte/lettrage) par ids, scindées par l'exercice. */
async function getLignesByIds(q: TxQuery, idClient: number, idLignes: number[]) {
  if (idLignes.length === 0) return [] as { id: number; compte: string; debit: number; credit: number; lettrage: string | null }[];
  const ids = idLignes.join(',');
  return q<{ id: number; compte: string; debit: number; credit: number; lettrage: string | null }>(
    `SELECT l.id,
            p.displayMember AS compte,
            CASE WHEN l.sens = -1 THEN l.montant ELSE 0 END AS debit,
            CASE WHEN l.sens =  1 THEN l.montant ELSE 0 END AS credit,
            l.lettrage
       FROM prismaCompta_ecritureLigne l
       ${JOIN_PLAN}
      WHERE l.idClientLigne = @idClient AND l.id IN (${ids})`,
    { idClient }
  );
}

/**
 * POST /api/lettrage/lettrer  { idClient, idLignes:number[] }
 * Contrôle d'équilibre (somme débits = somme crédits), au moins 2 lignes, même
 * compte ; génère le prochain code du compte et l'écrit sur les lignes.
 */
lettrageRouter.post(
  '/lettrer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, idLignes } = z
      .object({ idClient: z.number().int(), idLignes: z.array(z.number().int()).min(2) })
      .parse(req.body);

    const result = await withTransaction(async (q) => {
      const lignes = await getLignesByIds(q, idClient, idLignes);
      if (lignes.length < 2) throw new HttpError(400, 'Sélectionnez au moins deux lignes.');

      const comptes = new Set(lignes.map((l) => l.compte));
      if (comptes.size > 1) throw new HttpError(400, 'Toutes les lignes doivent appartenir au même compte.');
      const compte = lignes[0].compte;

      const totalDebit = round2(lignes.reduce((s, l) => s + Number(l.debit), 0));
      const totalCredit = round2(lignes.reduce((s, l) => s + Number(l.credit), 0));
      if (round2(totalDebit - totalCredit) !== 0) {
        throw new HttpError(400, `Lettrage impossible : le solde n'est pas nul (débit ${totalDebit}, crédit ${totalCredit}).`);
      }

      // Prochain code du compte, à partir des codes déjà utilisés sur ce compte.
      const existants = await q<{ lettrage: string }>(
        `SELECT DISTINCT l.lettrage
           FROM prismaCompta_ecritureLigne l
           ${JOIN_PLAN}
          WHERE l.idClientLigne = @idClient AND p.displayMember = @compte
            AND NULLIF(l.lettrage,'') IS NOT NULL`,
        { idClient, compte }
      );
      const code = nextLettrageCode(existants.map((e) => e.lettrage));

      await q(
        `UPDATE prismaCompta_ecritureLigne SET lettrage = @code WHERE id IN (${idLignes.join(',')})`,
        { code }
      );
      return { code, compte, nbLignes: lignes.length };
    });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/lettrage/delettrer  { idClient, idLignes:number[] }
 * Règle legacy : pour délettrer un code, TOUTES ses lignes doivent être
 * sélectionnées. On vérifie que la sélection couvre des groupes complets.
 */
lettrageRouter.post(
  '/delettrer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, idLignes } = z
      .object({ idClient: z.number().int(), idLignes: z.array(z.number().int()).min(1) })
      .parse(req.body);

    await withTransaction(async (q) => {
      const lignes = await getLignesByIds(q, idClient, idLignes);
      const codes = [...new Set(lignes.map((l) => (l.lettrage ?? '').trim()).filter(Boolean))];
      if (codes.length === 0) throw new HttpError(400, 'Aucune ligne lettrée sélectionnée.');

      // Chaque code sélectionné doit être entièrement couvert par la sélection.
      for (const code of codes) {
        const compte = lignes.find((l) => (l.lettrage ?? '').trim() === code)!.compte;
        const tot = await q<{ n: number }>(
          `SELECT COUNT(*) AS n
             FROM prismaCompta_ecritureLigne l
             ${JOIN_PLAN}
            WHERE l.idClientLigne = @idClient AND p.displayMember = @compte AND l.lettrage = @code`,
          { idClient, compte, code }
        );
        const selectionnees = lignes.filter((l) => (l.lettrage ?? '').trim() === code).length;
        if ((tot[0]?.n ?? 0) !== selectionnees) {
          throw new HttpError(409, `Délettrage impossible : sélectionnez toutes les lignes du lettrage « ${code} ».`);
        }
      }

      await q(
        `UPDATE prismaCompta_ecritureLigne SET lettrage = NULL WHERE id IN (${idLignes.join(',')})`,
      );
    });
    res.json({ ok: true });
  })
);

/**
 * POST /api/lettrage/auto  { idClient, compte }
 * Lettrage automatique par égalité de montant : apparie une ligne débit et une
 * ligne crédit de même montant non lettrées (cas dominant facture ↔ règlement).
 */
lettrageRouter.post(
  '/auto',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, compte } = z.object({ idClient: z.number().int(), compte: z.string().min(1) }).parse(req.body);

    const result = await withTransaction(async (q) => {
      const lignes = await q<{ id: number; debit: number; credit: number }>(
        `SELECT l.id,
                CASE WHEN l.sens = -1 THEN l.montant ELSE 0 END AS debit,
                CASE WHEN l.sens =  1 THEN l.montant ELSE 0 END AS credit
           FROM prismaCompta_ecritureLigne l
           ${JOIN_PLAN}
          WHERE l.idClientLigne = @idClient AND p.displayMember = @compte
            AND NULLIF(l.lettrage,'') IS NULL
          ORDER BY l.dateEcritureLigne, l.id`,
        { idClient, compte }
      );

      const debits = lignes.filter((l) => Number(l.debit) > 0).map((l) => ({ id: l.id, montant: round2(Number(l.debit)) }));
      const credits = lignes.filter((l) => Number(l.credit) > 0).map((l) => ({ id: l.id, montant: round2(Number(l.credit)) }));

      // Codes déjà utilisés sur le compte (pour continuer la séquence).
      const existants = await q<{ lettrage: string }>(
        `SELECT DISTINCT l.lettrage FROM prismaCompta_ecritureLigne l ${JOIN_PLAN}
          WHERE l.idClientLigne = @idClient AND p.displayMember = @compte AND NULLIF(l.lettrage,'') IS NOT NULL`,
        { idClient, compte }
      );
      const codes = existants.map((e) => e.lettrage);

      let nbLettres = 0;
      const creditUtilise = new Set<number>();
      for (const d of debits) {
        const c = credits.find((x) => !creditUtilise.has(x.id) && x.montant === d.montant);
        if (!c) continue;
        creditUtilise.add(c.id);
        const code = nextLettrageCode(codes);
        codes.push(code);
        await q(`UPDATE prismaCompta_ecritureLigne SET lettrage = @code WHERE id IN (${d.id}, ${c.id})`, { code });
        nbLettres += 2;
      }
      return { nbLignesLettrees: nbLettres };
    });
    res.json({ ok: true, ...result });
  })
);
