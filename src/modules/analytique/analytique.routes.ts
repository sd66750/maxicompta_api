import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const analytiqueRouter = Router();

/**
 * Analytique. Deux usages :
 *  - saisie d'écriture (cascade compte→nature→section) : /comptes, /sections, /nature-sections ;
 *  - gestion du référentiel : CRUD sections & natures, associations compte↔nature et nature↔section.
 */

// ---------------------------------------------------------------------------
// Lectures utilisées par la saisie (natures/sections actives, associations).
// ---------------------------------------------------------------------------

/** GET /api/analytique/comptes — associations compte → nature (natures actives). */
analytiqueRouter.get('/comptes', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(
    `SELECT LTRIM(RTRIM(cn.compte)) AS compte, cn.idNature,
            LTRIM(RTRIM(n.code)) AS code, LTRIM(RTRIM(n.libelle)) AS libelle
       FROM prismaCompta_analytique_CompteNature cn
       JOIN prismaCompta_natureAnalytique n ON n.id = cn.idNature AND ISNULL(n.isActif,0) = 1
      ORDER BY cn.compte`
  ));
}));

/** GET /api/analytique/sections — sections actives (avec hiérarchie). */
analytiqueRouter.get('/sections', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(
    `SELECT id, LTRIM(RTRIM(code)) AS code, LTRIM(RTRIM(libelle)) AS libelle, ISNULL(idParent,0) AS idParent, ISNULL(isActif,0) AS isActif
       FROM prismaCompta_sectionAnalytique WHERE ISNULL(isActif,0) = 1 ORDER BY code`
  ));
}));

/** GET /api/analytique/nature-sections — sections (actives) associées à chaque nature. */
analytiqueRouter.get('/nature-sections', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(
    `SELECT ns.idNature, ns.idSection
       FROM prismaCompta_natureSectionAnalytique ns
       JOIN prismaCompta_sectionAnalytique s ON s.id = ns.idSection AND ISNULL(s.isActif,0) = 1`
  ));
}));

// ---------------------------------------------------------------------------
// Gestion du référentiel.
// ---------------------------------------------------------------------------

/** GET /api/analytique/sections/all — toutes les sections (actives ET inactives). */
analytiqueRouter.get('/sections/all', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(
    `SELECT id, LTRIM(RTRIM(code)) AS code, LTRIM(RTRIM(libelle)) AS libelle, ISNULL(idParent,0) AS idParent, ISNULL(isActif,0) AS isActif
       FROM prismaCompta_sectionAnalytique ORDER BY code`
  ));
}));

/** GET /api/analytique/natures/all — toutes les natures. */
analytiqueRouter.get('/natures/all', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(
    `SELECT n.id, LTRIM(RTRIM(n.code)) AS code, LTRIM(RTRIM(n.libelle)) AS libelle, n.idGroupe,
            LTRIM(RTRIM(g.libelle)) AS groupe, ISNULL(n.isActif,0) AS isActif
       FROM prismaCompta_natureAnalytique n
       LEFT JOIN prismaCompta_natureAnalytiqueGroupe g ON g.id = n.idGroupe
      ORDER BY n.code`
  ));
}));

/** GET /api/analytique/groupes — groupes de natures. */
analytiqueRouter.get('/groupes', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await query(`SELECT id, LTRIM(RTRIM(libelle)) AS libelle FROM prismaCompta_natureAnalytiqueGroupe ORDER BY libelle`));
}));

const sectionBody = z.object({
  code: z.string().trim().min(1).max(255),
  libelle: z.string().trim().max(255).optional().default(''),
  idParent: z.number().int().nullable().optional(),
  isActif: z.boolean().default(true),
});

/** POST /api/analytique/sections — création d'une section. */
analytiqueRouter.post('/sections', requireAuth, asyncHandler(async (req, res) => {
  const b = sectionBody.parse(req.body);
  const r = await query<{ id: number }>(
    `INSERT INTO prismaCompta_sectionAnalytique (code, libelle, idParent, isActif)
     VALUES (@code, @libelle, @idParent, @isActif);
     SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`,
    { code: b.code, libelle: b.libelle || b.code, idParent: b.idParent ?? 0, isActif: b.isActif }
  );
  res.json({ ok: true, id: r[0]?.id });
}));

/** PUT /api/analytique/sections/:id — modification. */
analytiqueRouter.put('/sections/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = sectionBody.parse(req.body);
  await query(
    `UPDATE prismaCompta_sectionAnalytique SET code=@code, libelle=@libelle, idParent=@idParent, isActif=@isActif WHERE id=@id`,
    { id, code: b.code, libelle: b.libelle || b.code, idParent: b.idParent ?? 0, isActif: b.isActif }
  );
  res.json({ ok: true });
}));

/** DELETE /api/analytique/sections/:id — suppression (refusée si référencée). */
analytiqueRouter.delete('/sections/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const used = await query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM prismaCompta_ecritureLigne WHERE idSectionAnalytiqueLigne=@id)
          + (SELECT COUNT(*) FROM prismaCompta_natureSectionAnalytique WHERE idSection=@id)
          + (SELECT COUNT(*) FROM prismaCompta_sectionAnalytique WHERE idParent=@id) AS n`,
    { id }
  );
  if ((used[0]?.n ?? 0) > 0) throw new HttpError(409, 'Section utilisée (écritures, associations ou sous-sections) : désactivez-la plutôt.');
  await query(`DELETE FROM prismaCompta_sectionAnalytique WHERE id=@id`, { id });
  res.json({ ok: true });
}));

const natureBody = z.object({
  code: z.string().trim().min(1).max(255),
  libelle: z.string().trim().max(255).optional().default(''),
  idGroupe: z.number().int().nullable().optional(),
  isActif: z.boolean().default(true),
});

/** POST /api/analytique/natures — création d'une nature. */
analytiqueRouter.post('/natures', requireAuth, asyncHandler(async (req, res) => {
  const b = natureBody.parse(req.body);
  const r = await query<{ id: number }>(
    `INSERT INTO prismaCompta_natureAnalytique (code, libelle, idGroupe, isActif)
     VALUES (@code, @libelle, @idGroupe, @isActif);
     SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`,
    { code: b.code, libelle: b.libelle || b.code, idGroupe: b.idGroupe ?? null, isActif: b.isActif }
  );
  res.json({ ok: true, id: r[0]?.id });
}));

/** PUT /api/analytique/natures/:id — modification. */
analytiqueRouter.put('/natures/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = natureBody.parse(req.body);
  await query(
    `UPDATE prismaCompta_natureAnalytique SET code=@code, libelle=@libelle, idGroupe=@idGroupe, isActif=@isActif WHERE id=@id`,
    { id, code: b.code, libelle: b.libelle || b.code, idGroupe: b.idGroupe ?? null, isActif: b.isActif }
  );
  res.json({ ok: true });
}));

/** DELETE /api/analytique/natures/:id — suppression (refusée si référencée). */
analytiqueRouter.delete('/natures/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const used = await query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM prismaCompta_ecritureLigne WHERE idNatureAnalytiqueLigne=@id)
          + (SELECT COUNT(*) FROM prismaCompta_analytique_CompteNature WHERE idNature=@id)
          + (SELECT COUNT(*) FROM prismaCompta_natureSectionAnalytique WHERE idNature=@id) AS n`,
    { id }
  );
  if ((used[0]?.n ?? 0) > 0) throw new HttpError(409, 'Nature utilisée (écritures ou associations) : désactivez-la plutôt.');
  await query(`DELETE FROM prismaCompta_natureAnalytique WHERE id=@id`, { id });
  res.json({ ok: true });
}));

// --- Associations compte ↔ nature ---
const cnBody = z.object({ compte: z.string().trim().min(1).max(50), idNature: z.number().int() });

/** POST /api/analytique/comptes — associe un compte à une nature. */
analytiqueRouter.post('/comptes', requireAuth, asyncHandler(async (req, res) => {
  const { compte, idNature } = cnBody.parse(req.body);
  await query(
    `IF NOT EXISTS (SELECT 1 FROM prismaCompta_analytique_CompteNature WHERE compte=@compte AND idNature=@idNature)
       INSERT INTO prismaCompta_analytique_CompteNature (compte, idNature) VALUES (@compte, @idNature)`,
    { compte, idNature }
  );
  res.json({ ok: true });
}));

/** DELETE /api/analytique/comptes — retire l'association compte/nature. */
analytiqueRouter.delete('/comptes', requireAuth, asyncHandler(async (req, res) => {
  const { compte, idNature } = cnBody.parse(req.body);
  await query(`DELETE FROM prismaCompta_analytique_CompteNature WHERE compte=@compte AND idNature=@idNature`, { compte, idNature });
  res.json({ ok: true });
}));

/**
 * PUT /api/analytique/comptes/:compte — définit LA nature d'un compte (remplace
 * les associations existantes ; idNature null = aucune). Simplifie l'affectation
 * par compte (une nature par compte, cas courant).
 */
analytiqueRouter.put('/comptes/:compte', requireAuth, asyncHandler(async (req, res) => {
  const compte = z.string().trim().min(1).parse(req.params.compte);
  const { idNature } = z.object({ idNature: z.number().int().nullable() }).parse(req.body);
  await query(`DELETE FROM prismaCompta_analytique_CompteNature WHERE compte=@compte`, { compte });
  if (idNature != null) {
    await query(`INSERT INTO prismaCompta_analytique_CompteNature (compte, idNature) VALUES (@compte, @idNature)`, { compte, idNature });
  }
  res.json({ ok: true });
}));

// --- Associations nature ↔ section ---
const nsBody = z.object({ idNature: z.number().int(), idSection: z.number().int() });

/** POST /api/analytique/nature-sections — associe une nature à une section. */
analytiqueRouter.post('/nature-sections', requireAuth, asyncHandler(async (req, res) => {
  const { idNature, idSection } = nsBody.parse(req.body);
  await query(
    `IF NOT EXISTS (SELECT 1 FROM prismaCompta_natureSectionAnalytique WHERE idNature=@idNature AND idSection=@idSection)
       INSERT INTO prismaCompta_natureSectionAnalytique (idNature, idSection) VALUES (@idNature, @idSection)`,
    { idNature, idSection }
  );
  res.json({ ok: true });
}));

/** DELETE /api/analytique/nature-sections — retire l'association nature/section. */
analytiqueRouter.delete('/nature-sections', requireAuth, asyncHandler(async (req, res) => {
  const { idNature, idSection } = nsBody.parse(req.body);
  await query(`DELETE FROM prismaCompta_natureSectionAnalytique WHERE idNature=@idNature AND idSection=@idSection`, { idNature, idSection });
  res.json({ ok: true });
}));
