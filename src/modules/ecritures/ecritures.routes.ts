import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';
import { isAutoriseEcriture, saveEcriture, ecritureDate } from './ecritures.service.js';

export const ecrituresRouter = Router();

const idClientQuery = z.object({ idClient: z.coerce.number().int() });

/**
 * GET /api/periodes?idClient= — périodes (mois) DE L'EXERCICE. La table
 * prismaCompta_periode est globale ; on la restreint à l'intervalle
 * exerciceDebut..exerciceFin de l'exercice (prismaCompta_client), les plus
 * récentes d'abord. La fermeture est gérée par journal via l'autorisation
 * d'écriture (voir /ecritures/autorisation/check).
 */
ecrituresRouter.get(
  '/periodes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const rows = await query(
      `SELECT p.id, p.periode
         FROM prismaCompta_periode p
        WHERE p.periode >= (SELECT exerciceDebut FROM prismaCompta_client WHERE id = @idClient)
          AND p.periode <= (SELECT exerciceFin   FROM prismaCompta_client WHERE id = @idClient)
        ORDER BY p.periode DESC`,
      { idClient }
    );
    res.json(rows);
  })
);

/**
 * POST /api/ecritures/periodes — ouvre (crée) la période d'un mois de l'exercice.
 * Corps : { idClient, annee, mois }. La table prismaCompta_periode est GLOBALE
 * (une ligne par mois, partagée entre sociétés) : si le mois existe déjà, on
 * renvoie la ligne existante (idempotent). Date fixée au 15 du mois (comme le
 * legacy) pour éviter tout décalage de bord de mois (fuseau).
 */
ecrituresRouter.post(
  '/periodes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, annee, mois } = z
      .object({
        idClient: z.coerce.number().int(),
        annee: z.coerce.number().int().min(2000).max(2100),
        mois: z.coerce.number().int().min(1).max(12),
      })
      .parse(req.body);

    // Bornes de l'exercice en année/mois (sans ambiguïté de fuseau).
    const bornes = await query<{ yd: number; md: number; yf: number; mf: number }>(
      `SELECT YEAR(exerciceDebut) AS yd, MONTH(exerciceDebut) AS md,
              YEAR(exerciceFin)   AS yf, MONTH(exerciceFin)   AS mf
         FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    if (!bornes[0]) throw new HttpError(404, 'Exercice introuvable.');
    const { yd, md, yf, mf } = bornes[0];
    const cible = annee * 12 + (mois - 1);
    if (cible < yd * 12 + (md - 1) || cible > yf * 12 + (mf - 1)) {
      throw new HttpError(400, "Ce mois est hors de l'exercice courant.");
    }

    // Table globale : réutilise la période du mois si elle existe déjà.
    const existing = await query<{ id: number }>(
      `SELECT TOP 1 id FROM prismaCompta_periode WHERE YEAR(periode) = @annee AND MONTH(periode) = @mois`,
      { annee, mois }
    );
    if (existing[0]) {
      res.json({ id: existing[0].id, created: false });
      return;
    }
    const date = `${annee}-${String(mois).padStart(2, '0')}-15`;
    const ins = await query<{ id: number }>(
      `INSERT INTO prismaCompta_periode (periode) VALUES (@date);
       SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`,
      { date }
    );
    res.status(201).json({ id: ins[0]?.id, created: true });
  })
);

/** GET /api/ecritures?idClient=&journal=&idPeriode= — liste avec totaux. */
ecrituresRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { journal, idPeriode } = z
      .object({ journal: z.string().optional(), idPeriode: z.coerce.number().int().optional() })
      .parse(req.query);

    const rows = await query(
      `SELECT e.id, e.jour, e.piece, e.codeJournal, e.idPeriode, e.dateEcheance,
              p.periode AS moisPeriode,
              (SELECT ISNULL(SUM(CASE WHEN l.sens = -1 THEN l.montant ELSE 0 END), 0)
                 FROM prismaCompta_ecritureLigne l WHERE l.idEcriture = e.id) AS totalDebit,
              (SELECT ISNULL(SUM(CASE WHEN l.sens = 1 THEN l.montant ELSE 0 END), 0)
                 FROM prismaCompta_ecritureLigne l WHERE l.idEcriture = e.id) AS totalCredit
         FROM prismaCompta_ecriture e
         LEFT JOIN prismaCompta_periode p ON p.id = e.idPeriode
        WHERE e.idClient = @idClient
          AND (@journal IS NULL OR e.codeJournal = @journal)
          AND (@idPeriode IS NULL OR e.idPeriode = @idPeriode)
        ORDER BY e.id DESC`,
      { idClient, journal: journal ?? null, idPeriode: idPeriode ?? null }
    );
    res.json(rows);
  })
);

/**
 * GET /api/ecritures/lignes?idClient=&journal=&idPeriode= — détail LIGNE À LIGNE
 * (une ligne d'écriture = une ligne de liste), avec le libellé du compte (PCG)
 * et le libellé de la ligne, ordonné par écriture pour permettre la rupture par
 * pièce côté client. Doit précéder /:id (ordre de routage Express).
 */
ecrituresRouter.get(
  '/lignes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { journal, idPeriode } = z
      .object({ journal: z.string().optional(), idPeriode: z.coerce.number().int().optional() })
      .parse(req.query);

    const rows = await query(
      `SELECT e.id AS idEcriture, e.jour, e.piece, e.codeJournal, e.idPeriode, e.dateEcheance,
              p.periode AS moisPeriode,
              l.id AS idLigne, l.positionEcritureLigne,
              LTRIM(RTRIM(l.comptePCClient)) AS compte,
              LTRIM(RTRIM(pcg.libelle)) AS libelleCompte,
              l.libelle, l.montant, l.sens, l.lettrage,
              CASE WHEN l.sens = -1 THEN l.montant ELSE 0 END AS debit,
              CASE WHEN l.sens =  1 THEN l.montant ELSE 0 END AS credit
         FROM prismaCompta_ecriture e
         LEFT JOIN prismaCompta_periode p ON p.id = e.idPeriode
         JOIN prismaCompta_ecritureLigne l ON l.idEcriture = e.id
         LEFT JOIN prismaCompta_PCG pcg ON pcg.compte = l.comptePCClient AND pcg.idClient = e.idClient
        WHERE e.idClient = @idClient
          AND (@journal IS NULL OR e.codeJournal = @journal)
          AND (@idPeriode IS NULL OR e.idPeriode = @idPeriode)
        ORDER BY p.periode, TRY_CAST(e.jour AS INT), e.id, l.positionEcritureLigne, l.id`,
      { idClient, journal: journal ?? null, idPeriode: idPeriode ?? null }
    );
    res.json(rows);
  })
);

/** GET /api/ecritures/:id?idClient= — en-tête + lignes. */
ecrituresRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const id = z.coerce.number().int().parse(req.params.id);

    const entete = await query(
      `SELECT id, jour, piece, codeJournal, idClient, idPeriode, dateEcheance
         FROM prismaCompta_ecriture WHERE id = @id AND idClient = @idClient`,
      { id, idClient }
    );
    if (!entete[0]) throw new HttpError(404, 'Écriture introuvable.');

    const lignes = await query(
      `SELECT id, idEcriture, comptePCClient, libelle, montant, sens, lettrage,
              idSectionAnalytiqueLigne AS idSection, idNatureAnalytiqueLigne AS idNature,
              CASE WHEN sens = -1 THEN montant ELSE 0 END AS debit,
              CASE WHEN sens =  1 THEN montant ELSE 0 END AS credit
         FROM prismaCompta_ecritureLigne
        WHERE idEcriture = @id
        ORDER BY id`,
      { id }
    );
    res.json({ entete: entete[0], lignes });
  })
);

const saveSchema = z.object({
  id: z.number().int().nullish(),
  idClient: z.number().int(),
  codeJournal: z.string().min(1),
  idPeriode: z.number().int(),
  jour: z.number().int().min(1).max(31),
  piece: z.string().nullish(),
  lignes: z
    .array(
      z.object({
        comptePCClient: z.string().min(1),
        libelle: z.string().nullish(),
        debit: z.number().nullish(),
        credit: z.number().nullish(),
        lettrage: z.string().nullish(),
        idSection: z.number().int().nullish(),
        idNature: z.number().int().nullish(),
      })
    )
    .min(1),
});

/** POST /api/ecritures/save — sauvegarde (transaction + contrôles métier). */
ecrituresRouter.post(
  '/save',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = saveSchema.parse(req.body);
    const result = await saveEcriture(input);
    res.json({ ok: true, ...result });
  })
);

/** GET /api/ecritures/autorisation/check — vérifie période ouverte. */
ecrituresRouter.get(
  '/autorisation/check',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { codeJournal, date } = z.object({ codeJournal: z.string(), date: z.coerce.date() }).parse(req.query);
    const autorise = await isAutoriseEcriture(idClient, codeJournal, date);
    res.json({ autorise });
  })
);

/**
 * DELETE /api/ecritures/:id?idClient= — suppression.
 * Garde-fous (mêmes règles que la saisie) : exercice non clôturé, période ouverte
 * pour le journal (prismaCompta_isAutoriseEcriture), et écriture non lettrée.
 */
ecrituresRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const id = z.coerce.number().int().parse(req.params.id);

    const entete = await query<{ codeJournal: string; idPeriode: number; jour: string | null; moisPeriode: string | null; isCloture: boolean }>(
      `SELECT e.codeJournal, e.idPeriode, e.jour, p.periode AS moisPeriode, ISNULL(c.isCloture, 0) AS isCloture
         FROM prismaCompta_ecriture e
         JOIN prismaCompta_client c ON c.id = e.idClient
         LEFT JOIN prismaCompta_periode p ON p.id = e.idPeriode
        WHERE e.id = @id AND e.idClient = @idClient`,
      { id, idClient }
    );
    if (!entete[0]) throw new HttpError(404, 'Écriture introuvable.');
    const e = entete[0];

    // Exercice clôturé : aucune suppression possible.
    if (e.isCloture) {
      throw new HttpError(409, 'Exercice clôturé : suppression impossible.');
    }

    // Période fermée pour ce journal (même contrôle que la saisie).
    if (e.moisPeriode) {
      const dateEcriture = ecritureDate(e.moisPeriode, Number(e.jour) || 1);
      const autorise = await isAutoriseEcriture(idClient, e.codeJournal, dateEcriture);
      if (!autorise) {
        throw new HttpError(409, 'Période fermée sur ce journal : suppression impossible. Rouvrez la période d’abord.');
      }
    }

    const lettree = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM prismaCompta_ecritureLigne
        WHERE idEcriture = @id AND lettrage IS NOT NULL AND LTRIM(RTRIM(lettrage)) <> ''`,
      { id }
    );
    if ((lettree[0]?.n ?? 0) > 0) {
      throw new HttpError(409, 'Impossible de supprimer : écriture lettrée. Délettrez-la d’abord.');
    }

    await query(`DELETE FROM prismaCompta_ecritureLigne WHERE idEcriture = @id`, { id });
    await query(`DELETE FROM prismaCompta_ecriture WHERE id = @id AND idClient = @idClient`, { id, idClient });
    res.json({ ok: true });
  })
);
