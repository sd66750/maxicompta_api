import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const rapprochementRouter = Router();

/**
 * Rapprochement bancaire par journal (reprise de RapprochementBancaire.cs).
 * On pointe les mouvements du compte de banque contre le relevé ; l'état de
 * pointage est mémorisé dans une table web propre (prismaCompta_web_rapprochement,
 * une ligne = mouvement pointé), au lieu du blob .NET sérialisé du legacy.
 */

let tablePrete = false;
async function ensureTable(): Promise<void> {
  if (tablePrete) return;
  await query(
    `IF OBJECT_ID('prismaCompta_web_rapprochement','U') IS NULL
       CREATE TABLE prismaCompta_web_rapprochement (
         idEcritureLigne INT NOT NULL PRIMARY KEY,
         idClient        INT NOT NULL,
         datePointage    DATETIME NOT NULL CONSTRAINT DF_web_rappro_date DEFAULT GETDATE()
       )`
  );
  tablePrete = true;
}

/** GET /api/rapprochement/journaux?idClient= — journaux de banque + compte rattaché. */
rapprochementRouter.get(
  '/journaux',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const rows = await query<{ code: string; libelle: string; compteBanque: string }>(
      `SELECT code, libelle, LTRIM(RTRIM(compteBanqueRattache)) AS compteBanque
         FROM prismaCompta_journal
        WHERE idClient = @idClient AND NULLIF(LTRIM(RTRIM(compteBanqueRattache)),'') IS NOT NULL
        ORDER BY code`,
      { idClient }
    );
    res.json(rows);
  })
);

/**
 * GET /api/rapprochement/mouvements?idClient=&compte=&dateDu=&dateAu=
 * Mouvements du compte de banque sur la période, avec l'indicateur « pointé ».
 */
rapprochementRouter.get(
  '/mouvements',
  requireAuth,
  asyncHandler(async (req, res) => {
    await ensureTable();
    const { compte, dateAu, mode } = z
      .object({
        idClient: z.coerce.number().int(),
        compte: z.string().min(1),
        dateDu: z.string().optional(),
        dateAu: z.string().optional(),
        mode: z.enum(['nonpointe', 'pointe', 'toutes']).optional(),
      })
      .parse(req.query);

    // Comme le legacy (RapprochementBancaire.cs) : le solde du journal = l'ensemble
    // des écritures du compte sur TOUS les exercices, en EXCLUANT les à-nouveau
    // annuels (report qui double-compterait) mais en CONSERVANT l'à-nouveau
    // d'OUVERTURE (celui du 1er exercice = solde de départ réel), jusqu'à la date
    // d'arrêté. L'à-nouveau d'ouverture est considéré comme déjà pointé (position
    // de départ rapprochée). Une ligne est « pointée » si rapprochée dans PrismaSoft
    // (prisma_compta_releveBanqueLigne_ligne, lecture seule) OU dans la table web ;
    // la date de pointage vient du web, sinon du legacy (dateRapprochementPointage).
    const rows = await query(
      `WITH ligne AS (
          SELECT l.id, l.idEcriture, l.dateEcritureLigne, l.codeJournalLigne,
                 l.pieceLigne, l.libelle, l.sens, l.montant, l.idClientLigne,
                 CASE WHEN EXISTS (SELECT 1 FROM prismaCompta_journal j
                                    WHERE LTRIM(RTRIM(j.code)) = LTRIM(RTRIM(l.codeJournalLigne))
                                      AND j.idClient = l.idClientLigne AND j.typeJournal = 'AN')
                      THEN 1 ELSE 0 END AS isAN
            FROM prismaCompta_ecritureLigne l
           WHERE LTRIM(RTRIM(l.comptePCClient)) = @compte
       ),
       minan AS (SELECT MIN(idClientLigne) AS minAnExo FROM ligne WHERE isAN = 1)
       SELECT l.id                                              AS idLigne,
              l.idEcriture                                      AS idEcriture,
              l.dateEcritureLigne                               AS dateEcriture,
              l.codeJournalLigne                                AS codeJournal,
              l.pieceLigne                                      AS piece,
              l.libelle                                         AS libelle,
              CASE WHEN l.sens = -1 THEN l.montant END          AS debit,
              CASE WHEN l.sens =  1 THEN l.montant END          AS credit,
              CASE WHEN (l.isAN = 1 AND l.idClientLigne = m.minAnExo)
                        OR r.idEcritureLigne IS NOT NULL OR g.idEcritureLigne IS NOT NULL
                   THEN 1 ELSE 0 END                            AS pointe,
              CASE WHEN g.idEcritureLigne IS NOT NULL
                        OR (l.isAN = 1 AND l.idClientLigne = m.minAnExo)
                   THEN 1 ELSE 0 END                            AS legacy,
              COALESCE(r.datePointage, g.dateRappro,
                       CASE WHEN l.isAN = 1 AND l.idClientLigne = m.minAnExo
                            THEN l.dateEcritureLigne END)       AS datePointage
         FROM ligne l
         CROSS JOIN minan m
         LEFT JOIN prismaCompta_web_rapprochement r ON r.idEcritureLigne = l.id
         LEFT JOIN (SELECT idEcritureLigne, MAX(dateRapprochementPointage) AS dateRappro
                      FROM prisma_compta_releveBanqueLigne_ligne GROUP BY idEcritureLigne) g
                ON g.idEcritureLigne = l.id
        WHERE (l.isAN = 0 OR l.idClientLigne = m.minAnExo)
          ${dateAu ? 'AND l.dateEcritureLigne < DATEADD(day, 1, @dateAu)' : ''}
          ${mode === 'nonpointe'
            ? 'AND NOT (l.isAN = 1 AND l.idClientLigne = m.minAnExo) AND r.idEcritureLigne IS NULL AND g.idEcritureLigne IS NULL'
            : mode === 'pointe'
              ? 'AND ((l.isAN = 1 AND l.idClientLigne = m.minAnExo) OR r.idEcritureLigne IS NOT NULL OR g.idEcritureLigne IS NOT NULL)'
              : ''}
        ORDER BY l.dateEcritureLigne, l.id`,
      { compte, dateAu: dateAu ?? null }
    );
    res.json(rows);
  })
);

/**
 * GET /api/rapprochement/totaux?idClient=&compte=&dateAu=
 * État de rapprochement calculé sur TOUTES les lignes du compte (tous exercices,
 * hors AN, jusqu'à la date d'arrêté) — indépendant du filtre d'affichage, pour
 * que les totaux restent justes même si on ne charge qu'une partie des lignes.
 */
rapprochementRouter.get(
  '/totaux',
  requireAuth,
  asyncHandler(async (req, res) => {
    await ensureTable();
    const { compte, dateAu } = z
      .object({ idClient: z.coerce.number().int(), compte: z.string().min(1), dateAu: z.string().optional() })
      .parse(req.query);
    const rows = await query<{ soldeComptable: number | null; soldePointe: number | null; nb: number; nbPointes: number | null }>(
      `WITH ligne AS (
          SELECT l.id, l.dateEcritureLigne, l.sens, l.montant, l.idClientLigne,
                 CASE WHEN EXISTS (SELECT 1 FROM prismaCompta_journal j
                                    WHERE LTRIM(RTRIM(j.code)) = LTRIM(RTRIM(l.codeJournalLigne))
                                      AND j.idClient = l.idClientLigne AND j.typeJournal = 'AN')
                      THEN 1 ELSE 0 END AS isAN
            FROM prismaCompta_ecritureLigne l
           WHERE LTRIM(RTRIM(l.comptePCClient)) = @compte
       ),
       minan AS (SELECT MIN(idClientLigne) AS minAnExo FROM ligne WHERE isAN = 1)
       SELECT
          SUM(CASE WHEN l.sens = -1 THEN l.montant ELSE -l.montant END) AS soldeComptable,
          SUM(CASE WHEN (l.isAN = 1 AND l.idClientLigne = m.minAnExo)
                        OR r.idEcritureLigne IS NOT NULL OR g.idEcritureLigne IS NOT NULL
                   THEN CASE WHEN l.sens = -1 THEN l.montant ELSE -l.montant END ELSE 0 END) AS soldePointe,
          COUNT(*) AS nb,
          SUM(CASE WHEN (l.isAN = 1 AND l.idClientLigne = m.minAnExo)
                        OR r.idEcritureLigne IS NOT NULL OR g.idEcritureLigne IS NOT NULL
                   THEN 1 ELSE 0 END) AS nbPointes
         FROM ligne l
         CROSS JOIN minan m
         LEFT JOIN prismaCompta_web_rapprochement r ON r.idEcritureLigne = l.id
         LEFT JOIN (SELECT DISTINCT idEcritureLigne FROM prisma_compta_releveBanqueLigne_ligne) g ON g.idEcritureLigne = l.id
        WHERE (l.isAN = 0 OR l.idClientLigne = m.minAnExo)
          ${dateAu ? 'AND l.dateEcritureLigne < DATEADD(day, 1, @dateAu)' : ''}`,
      { compte, dateAu: dateAu ?? null }
    );
    const r = rows[0];
    res.json({
      soldeComptable: r?.soldeComptable ?? 0,
      soldePointe: r?.soldePointe ?? 0,
      nb: r?.nb ?? 0,
      nbPointes: r?.nbPointes ?? 0,
    });
  })
);

/** POST /api/rapprochement/pointer — { idClient, idLignes:number[], pointe } : pointe / dépointe. */
rapprochementRouter.post(
  '/pointer',
  requireAuth,
  asyncHandler(async (req, res) => {
    await ensureTable();
    const { idClient, idLignes, pointe } = z
      .object({ idClient: z.number().int(), idLignes: z.array(z.number().int()).min(1), pointe: z.boolean() })
      .parse(req.body);

    const ids = idLignes.join(',');
    if (pointe) {
      await query(
        `INSERT INTO prismaCompta_web_rapprochement (idEcritureLigne, idClient)
         SELECT l.id, @idClient
           FROM prismaCompta_ecritureLigne l
          WHERE l.id IN (${ids})
            AND NOT EXISTS (SELECT 1 FROM prismaCompta_web_rapprochement r WHERE r.idEcritureLigne = l.id)`,
        { idClient }
      );
    } else {
      await query(`DELETE FROM prismaCompta_web_rapprochement WHERE idEcritureLigne IN (${ids})`, {});
    }
    res.json({ ok: true });
  })
);

/**
 * Solde du relevé mémorisé par le legacy dans prisma_compta_releveBanque
 * (une ligne par journal + date d'arrêté : montant absolu + sens ; sens = 1 pour
 * un solde positif, -1 pour négatif ; saisie manuelle = idImport NULL).
 * GET /api/rapprochement/solde?idClient=&codeJournal=&dateAu=
 */
rapprochementRouter.get(
  '/solde',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { codeJournal, dateAu } = z
      .object({ idClient: z.coerce.number().int(), codeJournal: z.string().min(1), dateAu: z.string().min(1) })
      .parse(req.query);
    const rows = await query<{ montant: number; sens: number }>(
      `SELECT TOP 1 montant, sens
         FROM prisma_compta_releveBanque
        WHERE LTRIM(RTRIM(codeJournal)) = @codeJournal AND CAST(date AS date) = CONVERT(date, @dateAu, 23)
        ORDER BY id DESC`,
      { codeJournal, dateAu }
    );
    const r = rows[0];
    res.json({ solde: r ? (r.sens === -1 ? -r.montant : r.montant) : null });
  })
);

/** POST /api/rapprochement/solde — mémorise le solde du relevé dans le legacy (upsert de l'entrée manuelle du journal à cette date). */
rapprochementRouter.post(
  '/solde',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { codeJournal, dateAu, solde } = z
      .object({ idClient: z.number().int(), codeJournal: z.string().min(1), dateAu: z.string().min(1), solde: z.number() })
      .parse(req.body);
    const montant = Math.abs(solde);
    const sens = solde < 0 ? -1 : 1;
    await query(
      `DECLARE @id INT = (SELECT MAX(id) FROM prisma_compta_releveBanque
                           WHERE LTRIM(RTRIM(codeJournal)) = @codeJournal
                             AND CAST(date AS date) = CONVERT(date, @dateAu, 23)
                             AND idImport IS NULL);
       IF @id IS NULL
         INSERT INTO prisma_compta_releveBanque (date, montant, sens, codeJournal, idImport)
         VALUES (CONVERT(datetime, @dateAu, 23), @montant, @sens, @codeJournal, NULL);
       ELSE
         UPDATE prisma_compta_releveBanque SET montant = @montant, sens = @sens WHERE id = @id;`,
      { codeJournal, dateAu, montant, sens }
    );
    res.json({ ok: true });
  })
);
