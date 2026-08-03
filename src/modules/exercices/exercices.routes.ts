import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const exercicesRouter = Router();

interface SocieteRow {
  idSociete: number;
  nom: string | null;
}

interface ExerciceRow {
  id: number;
  idSociete: number;
  nom: string | null;
  nomImpression: string | null;
  exerciceDebut: string;
  exerciceFin: string;
  moisDebutExercice: number | null;
  isCloture: boolean | null;
}

/** GET /api/societes — liste des sociétés (idSociete distinct). */
exercicesRouter.get(
  '/societes',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const rows = await query<SocieteRow>(
      `SELECT c.idSociete,
              MAX(ISNULL(c.nomImpression, c.nom)) AS nom
         FROM prismaCompta_client c
        WHERE c.idSociete IS NOT NULL
        GROUP BY c.idSociete
        ORDER BY nom`
    );
    res.json(rows);
  })
);

/** GET /api/exercices?idSociete= — exercices d'une société, du plus récent au plus ancien. */
exercicesRouter.get(
  '/exercices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idSociete } = z.object({ idSociete: z.coerce.number().int() }).parse(req.query);
    const rows = await query<ExerciceRow>(
      `SELECT id, idSociete, nom, nomImpression, exerciceDebut, exerciceFin,
              moisDebutExercice, isCloture
         FROM prismaCompta_client
        WHERE idSociete = @idSociete
        ORDER BY exerciceDebut DESC`,
      { idSociete }
    );
    res.json(rows);
  })
);
