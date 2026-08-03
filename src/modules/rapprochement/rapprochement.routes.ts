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
    const { idClient, compte, dateDu, dateAu } = z
      .object({
        idClient: z.coerce.number().int(),
        compte: z.string().min(1),
        dateDu: z.string().optional(),
        dateAu: z.string().optional(),
      })
      .parse(req.query);

    // Une ligne est « pointée » si elle est rapprochée dans PrismaSoft
    // (prisma_compta_releveBanqueLigne_ligne, en lecture seule) OU dans la table
    // web. `legacy` distingue les pointages historiques (non modifiables ici).
    const rows = await query(
      `SELECT l.id                                              AS idLigne,
              l.idEcriture                                      AS idEcriture,
              l.dateEcritureLigne                               AS dateEcriture,
              l.codeJournalLigne                                AS codeJournal,
              l.pieceLigne                                      AS piece,
              l.libelle                                         AS libelle,
              CASE WHEN l.sens = -1 THEN l.montant END          AS debit,
              CASE WHEN l.sens =  1 THEN l.montant END          AS credit,
              CASE WHEN r.idEcritureLigne IS NULL AND g.idEcritureLigne IS NULL THEN 0 ELSE 1 END AS pointe,
              CASE WHEN g.idEcritureLigne IS NULL THEN 0 ELSE 1 END AS legacy
         FROM prismaCompta_ecritureLigne l
         LEFT JOIN prismaCompta_web_rapprochement r ON r.idEcritureLigne = l.id
         LEFT JOIN (SELECT DISTINCT idEcritureLigne FROM prisma_compta_releveBanqueLigne_ligne) g
                ON g.idEcritureLigne = l.id
        WHERE l.idClientLigne = @idClient
          AND LTRIM(RTRIM(l.comptePCClient)) = @compte
          ${dateDu ? 'AND l.dateEcritureLigne >= @dateDu' : ''}
          ${dateAu ? 'AND l.dateEcritureLigne < DATEADD(day, 1, @dateAu)' : ''}
        ORDER BY l.dateEcritureLigne, l.id`,
      { idClient, compte, dateDu: dateDu ?? null, dateAu: dateAu ?? null }
    );
    res.json(rows);
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
