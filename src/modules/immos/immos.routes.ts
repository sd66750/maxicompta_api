import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const immosRouter = Router();

/**
 * Immobilisations (PrismaCompta_Immo_Immobilisation). La table est globale à la
 * société (pas d'idClient/idExercice). Suppression = marquage isSupprimeImmo.
 */

const SELECT_LIST = `
  SELECT i.id, i.code, i.libelle,
         i.idFamilleImmobilisations, f.libelle AS famille,
         i.dateAchat, i.dateMiseEnService, i.valeurAchat, i.valeurFiscale,
         i.amortissementTypeAmortissement, i.amortissementDuree, i.amortissementTaux,
         i.typeImmobilisation, i.numPieceComptable, i.commentaire, i.isActive
    FROM PrismaCompta_Immo_Immobilisation i
    LEFT JOIN PrismaCompta_Immo_FamilleImmobilisation f ON f.id = i.idFamilleImmobilisations
   WHERE ISNULL(i.isSupprimeImmo, 0) = 0
     AND ISNULL(i.isActive, 1) = 1`;

/** GET /api/immos — liste des immobilisations (hors supprimées). */
immosRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const rows = await query(`${SELECT_LIST} ORDER BY TRY_CAST(i.code AS INT), i.code`);
    res.json(rows);
  })
);

/**
 * GET /api/immos/amortissements?dateButoir=YYYY-MM-DD
 * Matrice des amortissements : par immo, dotation annuelle par année.
 * Source = table `..._reprise` (montants RÉELLEMENT comptabilisés par PrismaSoft,
 * base jours réels/365) pour les années passées ; calcul linéaire pour les années
 * futures (au-delà de la dernière reprise), avec prorata de l'année butoir
 * (jours réels/365). Total ligne = cumul d'amortissement à la date butoir.
 */
immosRouter.get(
  '/amortissements',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { dateButoir } = z.object({ dateButoir: z.string().optional() }).parse(req.query);
    const butoir = dateButoir ? new Date(dateButoir) : new Date();
    const butoirYear = butoir.getUTCFullYear();
    const estFinAnnee = butoir.getUTCMonth() === 11 && butoir.getUTCDate() === 31;
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const jour = (d: Date) => Math.floor(d.getTime() / 86400000);

    const immos = await query<{ id: number; code: string; libelle: string; valeurAchat: number; mes: string | null; duree: number | null; taux: number | null; famille: string | null }>(
      `SELECT i.id, LTRIM(RTRIM(i.code)) AS code, i.libelle, i.valeurAchat,
              CONVERT(varchar, i.dateMiseEnService, 23) AS mes,
              i.amortissementDuree AS duree, i.amortissementTaux AS taux,
              f.libelle AS famille
         FROM PrismaCompta_Immo_Immobilisation i
         LEFT JOIN PrismaCompta_Immo_FamilleImmobilisation f ON f.id = i.idFamilleImmobilisations
        WHERE ISNULL(i.isSupprimeImmo, 0) = 0 AND ISNULL(i.isActive, 1) = 1
        ORDER BY f.libelle, TRY_CAST(i.code AS INT), i.code`
    );
    const reprises = await query<{ idImmobilisation: number; annee: number; cumul: number }>(
      `SELECT idImmobilisation, YEAR(dateReprise) AS annee, valeurReprise AS cumul
         FROM PrismaCompta_Immo_Immobilisation_reprise ORDER BY idImmobilisation, dateReprise`
    );
    const repriseMap = new Map<number, { annee: number; cumul: number }[]>();
    for (const r of reprises) {
      const arr = repriseMap.get(r.idImmobilisation) ?? [];
      arr.push({ annee: r.annee, cumul: Number(r.cumul) });
      repriseMap.set(r.idImmobilisation, arr);
    }

    const anneesSet = new Set<number>();
    const lignes = immos.map((im) => {
      const base = Number(im.valeurAchat) || 0;
      const tauxFr = im.taux ? Number(im.taux) / 100 : im.duree ? 1 / Number(im.duree) : 0;
      const annuite = base * tauxFr;
      const rep = (repriseMap.get(im.id) ?? []).filter((r) => r.annee <= butoirYear).sort((a, b) => a.annee - b.annee);
      const dotations: Record<number, number> = {};
      let cumul = 0;
      let lastYear: number | null = null;
      for (const r of rep) {
        const dot = round2(r.cumul - cumul);
        dotations[r.annee] = dot;
        anneesSet.add(r.annee);
        cumul = r.cumul;
        lastYear = r.annee;
      }
      // Années futures (au-delà de la reprise) jusqu'au butoir.
      const mesYear = im.mes ? Number(im.mes.slice(0, 4)) : butoirYear;
      let y = lastYear !== null ? lastYear + 1 : mesYear;
      while (y <= butoirYear && cumul < base - 0.005 && annuite > 0) {
        let dot: number;
        const debutAnnee = lastYear === null && y === mesYear && im.mes ? new Date(im.mes) : new Date(Date.UTC(y, 0, 1));
        if (y === butoirYear && !estFinAnnee) {
          const jours = Math.max(0, jour(butoir) - jour(debutAnnee) + 1);
          dot = annuite * (jours / 365);
        } else if (lastYear === null && y === mesYear && im.mes) {
          const jours = jour(new Date(Date.UTC(y, 11, 31))) - jour(new Date(im.mes)) + 1;
          dot = annuite * (jours / 365);
        } else {
          dot = annuite;
        }
        dot = round2(Math.min(dot, base - cumul));
        if (dot > 0) {
          dotations[y] = dot;
          anneesSet.add(y);
          cumul = round2(cumul + dot);
        }
        y++;
      }
      return { id: im.id, code: im.code, libelle: (im.libelle || '').trim(), famille: im.famille?.trim() || null, valeurAchat: base, dotations, cumul: round2(cumul), vnc: round2(base - cumul) };
    });

    const annees = [...anneesSet].sort((a, b) => a - b);
    const totauxParAnnee: Record<number, number> = {};
    for (const a of annees) totauxParAnnee[a] = round2(lignes.reduce((s, l) => s + (l.dotations[a] || 0), 0));
    res.json({ annees, lignes, totauxParAnnee, dateButoir: dateButoir ?? null });
  })
);

/** GET /api/immos/familles — familles d'immobilisations. */
immosRouter.get(
  '/familles',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const rows = await query(`SELECT id, libelle FROM PrismaCompta_Immo_FamilleImmobilisation ORDER BY libelle`);
    res.json(rows);
  })
);

const bodySchema = z.object({
  code: z.string().trim().max(50).optional(),
  libelle: z.string().trim().min(1).max(255),
  idFamilleImmobilisations: z.number().int().nullable().optional(),
  dateAchat: z.string().min(8),
  dateMiseEnService: z.string().min(8),
  valeurAchat: z.number(),
  valeurFiscale: z.number().optional(),
  amortissementTypeAmortissement: z.enum(['Linéaire', 'Dégressif']).default('Linéaire'),
  amortissementDuree: z.number().int().nullable().optional(),
  amortissementTaux: z.number().nullable().optional(),
  typeImmobilisation: z.string().default('Immobilisation'),
  numPieceComptable: z.string().max(255).nullable().optional(),
  commentaire: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});
type ImmoBody = z.infer<typeof bodySchema>;

function params(b: ImmoBody, extra: Record<string, unknown> = {}) {
  return {
    libelle: b.libelle,
    idFamille: b.idFamilleImmobilisations ?? null,
    dateAchat: b.dateAchat,
    dateMiseEnService: b.dateMiseEnService,
    valeurAchat: b.valeurAchat,
    valeurFiscale: b.valeurFiscale ?? b.valeurAchat,
    typeAmort: b.amortissementTypeAmortissement,
    duree: b.amortissementDuree ?? null,
    taux: b.amortissementTaux ?? null,
    typeImmo: b.typeImmobilisation || 'Immobilisation',
    numPiece: b.numPieceComptable ?? null,
    commentaire: b.commentaire ?? null,
    isActive: b.isActive,
    ...extra,
  };
}

/** POST /api/immos — création. Le code est auto-généré si absent. */
immosRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = bodySchema.parse(req.body);
    let code = b.code?.trim();
    if (!code) {
      const r = await query<{ next: number }>(
        `SELECT ISNULL(MAX(TRY_CAST(code AS INT)), 0) + 1 AS next FROM PrismaCompta_Immo_Immobilisation`
      );
      code = String(r[0]?.next ?? 1);
    }
    const rows = await query<{ id: number }>(
      `INSERT INTO PrismaCompta_Immo_Immobilisation
         (code, libelle, idFamilleImmobilisations, dateAchat, dateMiseEnService, valeurAchat, valeurFiscale,
          amortissementTypeAmortissement, amortissementDuree, amortissementTaux, typeImmobilisation,
          numPieceComptable, commentaire, isActive, type, isSortieTotale, isAcquise, isSupprimeImmo)
       OUTPUT INSERTED.id
       VALUES (@code, @libelle, @idFamille, @dateAchat, @dateMiseEnService, @valeurAchat, @valeurFiscale,
          @typeAmort, @duree, @taux, @typeImmo, @numPiece, @commentaire, @isActive, @typeImmo, 0, 0, 0)`,
      params(b, { code })
    );
    res.json({ ok: true, id: rows[0]?.id });
  })
);

/** PUT /api/immos/:id — modification. */
immosRouter.put(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const b = bodySchema.parse(req.body);
    const exist = await query<{ id: number }>(
      `SELECT id FROM PrismaCompta_Immo_Immobilisation WHERE id = @id AND ISNULL(isSupprimeImmo,0) = 0`,
      { id }
    );
    if (!exist[0]) throw new HttpError(404, 'Immobilisation introuvable.');
    await query(
      `UPDATE PrismaCompta_Immo_Immobilisation SET
         libelle = @libelle, idFamilleImmobilisations = @idFamille,
         dateAchat = @dateAchat, dateMiseEnService = @dateMiseEnService,
         valeurAchat = @valeurAchat, valeurFiscale = @valeurFiscale,
         amortissementTypeAmortissement = @typeAmort, amortissementDuree = @duree, amortissementTaux = @taux,
         typeImmobilisation = @typeImmo, numPieceComptable = @numPiece, commentaire = @commentaire, isActive = @isActive
       WHERE id = @id`,
      params(b, { id })
    );
    res.json({ ok: true });
  })
);

/** DELETE /api/immos/:id — suppression logique (isSupprimeImmo = 1). */
immosRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    await query(`UPDATE PrismaCompta_Immo_Immobilisation SET isSupprimeImmo = 1 WHERE id = @id`, { id });
    res.json({ ok: true });
  })
);
