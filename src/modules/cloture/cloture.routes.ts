import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const clotureRouter = Router();

/**
 * Clôture par (journal, période). Table prismaCompta_cloturePeriodeParJournal
 * (codeJournal, idPeriode, idClientExercice, dateCloture) : une ligne = ce
 * journal fermé pour cette période. Fermer = insérer, rouvrir = supprimer.
 */

/**
 * GET /api/cloture/periodes?idClient= — périodes gérables pour la clôture.
 * Calqué sur le legacy FillByPourCloture : toutes les périodes >= exerciceDebut
 * ET antérieures au mois courant (pas de borne exerciceFin — on peut clôturer
 * des périodes postérieures à la fin d'exercice tant qu'elles sont passées).
 */
clotureRouter.get(
  '/periodes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const rows = await query<{ id: number; periode: string }>(
      `SELECT p.id, p.periode
         FROM prismaCompta_periode p
        INNER JOIN prismaCompta_client c ON c.id = @idClient AND p.periode >= c.exerciceDebut
        WHERE CONVERT(date, DATEADD(day, DAY(p.periode) * -1 + 1, p.periode))
            < CONVERT(date, DATEADD(day, DAY(GETDATE()) * -1 + 1, GETDATE()))
        ORDER BY p.periode`,
      { idClient }
    );
    res.json(rows);
  })
);

/** GET /api/cloture?idClient= — liste des (codeJournal, idPeriode) fermés. */
clotureRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const rows = await query<{ codeJournal: string; idPeriode: number }>(
      `SELECT codeJournal, idPeriode
         FROM prismaCompta_cloturePeriodeParJournal
        WHERE idClientExercice = @idClient`,
      { idClient }
    );
    res.json(rows);
  })
);

/** POST /api/cloture — { idClient, codeJournal, idPeriode, ferme } : ferme ou rouvre. */
clotureRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, codeJournal, idPeriode, ferme } = z
      .object({
        idClient: z.number().int(),
        codeJournal: z.string().min(1),
        idPeriode: z.number().int(),
        ferme: z.boolean(),
      })
      .parse(req.body);

    if (ferme) {
      await query(
        `IF NOT EXISTS (
           SELECT 1 FROM prismaCompta_cloturePeriodeParJournal
            WHERE codeJournal = @codeJournal AND idPeriode = @idPeriode AND idClientExercice = @idClient)
         INSERT INTO prismaCompta_cloturePeriodeParJournal (codeJournal, dateCloture, idPeriode, idClientExercice)
         VALUES (@codeJournal, GETDATE(), @idPeriode, @idClient)`,
        { codeJournal, idPeriode, idClient }
      );
    } else {
      await query(
        `DELETE FROM prismaCompta_cloturePeriodeParJournal
          WHERE codeJournal = @codeJournal AND idPeriode = @idPeriode AND idClientExercice = @idClient`,
        { codeJournal, idPeriode, idClient }
      );
    }
    res.json({ ok: true });
  })
);
