import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { queryOn, withTransactionOn } from '../../db/pool.js';

export const tiersRouter = Router();

/**
 * Tiers comptables (clients 411, fournisseurs 401, fournisseurs d'immobilisations 404).
 *
 * Dans PrismaSoft, un tiers est créé par la gestion commerciale, désormais
 * désolidarisée. On reproduit exactement ses écritures pour rester compatible
 * avec le logiciel d'origine et avec la vue prismaCompta_planComptable (plan
 * comptable, saisie, lettrage, états) :
 *   1. PrismaGestionCo_tiers ;
 *   2. PrismaGestionCo_tiers_client ou _fournisseur — le déclencheur
 *      onInsertClient / onInsertFournisseur calcule le compte (411/401 + id) ;
 *   3. prismaCompta_tiersCentralisateur_tiers (rattachement 411 / 401 / 404).
 * Le 404 n'est qu'un centralisateur : le compte individuel reste en 401…
 *
 * Les tables sont propres à chaque base société : chaque requête est routée vers
 * la base envoyée par le front (en-tête X-Societe-Db), jamais vers la société
 * active globale. Pas de suppression : un tiers peut être référencé par des
 * documents de la gestion commerciale — on le désactive (isActif = 0).
 */

/** Base société cible (en-tête X-Societe-Db). Fail-closed : erreur si absente. */
function reqDb(req: Request): string {
  const db = req.header('X-Societe-Db');
  if (!db) throw new HttpError(400, 'Société non spécifiée (en-tête X-Societe-Db manquant).');
  return db;
}

/** GET /api/tiers/centralisateurs — racines disponibles dans la société (411, 401, 404…). */
tiersRouter.get(
  '/centralisateurs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await queryOn(
      reqDb(req),
      `SELECT id, type, libelle, racine, CAST(ISNULL(isDefaut, 0) AS bit) AS isDefaut
         FROM prismaCompta_tiersCentralisateur
        ORDER BY racine`
    );
    res.json(rows);
  })
);

/** GET /api/tiers?search= — liste des tiers (hors prospects), avec leur compte. */
tiersRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { search } = z.object({ search: z.string().max(100).optional() }).parse(req.query);
    const rows = await queryOn(
      reqDb(req),
      `SELECT t.id, t.code, t.nom, t.raisonSociale, t.siret, t.tvaIntraCom,
              t.email, t.telephone, t.iban, t.bic,
              CAST(ISNULL(t.isClient, 0) AS bit)      AS isClient,
              CAST(ISNULL(t.isFournisseur, 0) AS bit) AS isFournisseur,
              CAST(t.isActif AS bit)                   AS isActif,
              COALESCE(tc.compteComptable, tf.compteComptable) AS compte,
              STUFF((SELECT ', ' + c.racine
                       FROM prismaCompta_tiersCentralisateur_tiers ct
                       JOIN prismaCompta_tiersCentralisateur c ON c.id = ct.idCentralisateur
                      WHERE ct.idTiers = t.id ORDER BY c.racine
                      FOR XML PATH('')), 1, 2, '') AS centralisateurs
         FROM PrismaGestionCo_tiers t
         LEFT JOIN PrismaGestionCo_tiers_client     tc ON tc.idTiers = t.id
         LEFT JOIN PrismaGestionCo_tiers_fournisseur tf ON tf.idTiers = t.id
        WHERE ISNULL(t.isProspect, 0) = 0
          AND (@search IS NULL
               OR t.code LIKE '%' + @search + '%'
               OR t.nom LIKE '%' + @search + '%'
               OR t.raisonSociale LIKE '%' + @search + '%'
               OR COALESCE(tc.compteComptable, tf.compteComptable) LIKE @search + '%')
        ORDER BY t.code`,
      { search: search?.trim() || null }
    );
    res.json(rows);
  })
);

const optStr = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const tiersBody = z.object({
  code: z.string().trim().min(1).max(25).transform((v) => v.toUpperCase()),
  nom: z.string().trim().min(1).max(200),
  raisonSociale: optStr(200),
  siret: optStr(25),
  tvaIntraCom: optStr(25),
  email: optStr(200),
  telephone: optStr(25),
  iban: optStr(200),
  bic: optStr(200),
});

/** POST /api/tiers — création { idCentralisateur, code, nom, ... }. */
tiersRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = reqDb(req);
    const body = tiersBody.extend({ idCentralisateur: z.number().int() }).parse(req.body);

    const result = await withTransactionOn(db, async (q) => {
      const [central] = await q<{ id: number; type: string; racine: string }>(
        `SELECT id, type, racine FROM prismaCompta_tiersCentralisateur WHERE id = @id`,
        { id: body.idCentralisateur }
      );
      if (!central) throw new HttpError(400, 'Centralisateur inconnu pour cette société.');
      const estClient = central.type.toUpperCase() === 'CLIENT';

      const [dejaCode] = await q<{ n: number }>(
        `SELECT COUNT(*) AS n FROM PrismaGestionCo_tiers WITH (UPDLOCK, HOLDLOCK) WHERE code = @code`,
        { code: body.code }
      );
      if (dejaCode.n > 0) throw new HttpError(409, `Le code « ${body.code} » est déjà utilisé par un autre tiers.`);

      // 1. Fiche tiers
      const [tiers] = await q<{ id: number }>(
        `INSERT INTO PrismaGestionCo_tiers
           (code, nom, raisonSociale, siret, tvaIntraCom, email, telephone, iban, bic,
            isClient, isFournisseur, isProspect, isActif)
         OUTPUT INSERTED.id
         VALUES (@code, @nom, @raisonSociale, @siret, @tvaIntraCom, @email, @telephone, @iban, @bic,
                 @isClient, @isFournisseur, 0, 1)`,
        {
          ...body,
          raisonSociale: body.raisonSociale ?? body.nom,
          isClient: estClient,
          isFournisseur: !estClient,
        }
      );

      // 2. Fiche client / fournisseur — le déclencheur calcule compteComptable.
      if (estClient) {
        await q(`INSERT INTO PrismaGestionCo_tiers_client (idTiers) VALUES (@id)`, { id: tiers.id });
      } else {
        await q(`INSERT INTO PrismaGestionCo_tiers_fournisseur (idTiers) VALUES (@id)`, { id: tiers.id });
      }

      // 3. Rattachement au centralisateur (411 / 401 / 404).
      await q(
        `INSERT INTO prismaCompta_tiersCentralisateur_tiers (idCentralisateur, idTiers) VALUES (@c, @t)`,
        { c: central.id, t: tiers.id }
      );

      const [compte] = await q<{ compte: string | null }>(
        estClient
          ? `SELECT compteComptable AS compte FROM PrismaGestionCo_tiers_client WHERE idTiers = @id`
          : `SELECT compteComptable AS compte FROM PrismaGestionCo_tiers_fournisseur WHERE idTiers = @id`,
        { id: tiers.id }
      );
      if (!compte?.compte) throw new HttpError(500, 'Le numéro de compte du tiers n’a pas été généré.');
      return { id: tiers.id, compte: compte.compte, racine: central.racine };
    });

    res.status(201).json({ ok: true, ...result });
  })
);

/** PUT /api/tiers/:id — modification (identité, coordonnées, actif). Le compte ne change pas. */
tiersRouter.put(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = reqDb(req);
    const id = z.coerce.number().int().parse(req.params.id);
    const body = tiersBody.extend({ isActif: z.boolean() }).parse(req.body);

    await withTransactionOn(db, async (q) => {
      const [dejaCode] = await q<{ n: number }>(
        `SELECT COUNT(*) AS n FROM PrismaGestionCo_tiers WITH (UPDLOCK, HOLDLOCK) WHERE code = @code AND id <> @id`,
        { code: body.code, id }
      );
      if (dejaCode.n > 0) throw new HttpError(409, `Le code « ${body.code} » est déjà utilisé par un autre tiers.`);

      const [r] = await q<{ n: number }>(
        `UPDATE PrismaGestionCo_tiers
            SET code = @code, nom = @nom, raisonSociale = @raisonSociale, siret = @siret,
                tvaIntraCom = @tvaIntraCom, email = @email, telephone = @telephone,
                iban = @iban, bic = @bic, isActif = @isActif
          WHERE id = @id AND ISNULL(isProspect, 0) = 0;
         SELECT @@ROWCOUNT AS n;`,
        { ...body, raisonSociale: body.raisonSociale ?? body.nom, id }
      );
      if (!r || r.n === 0) throw new HttpError(404, 'Tiers introuvable.');
    });
    res.json({ ok: true });
  })
);
