import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const planComptableRouter = Router();

const idClientQuery = z.object({ idClient: z.coerce.number().int() });

/** Longueur de compte de référence (zero-padding) — MAX(LEN(compte)) de la base. */
async function getLongueurCompte(): Promise<number> {
  const rows = await query<{ n: number | null }>(
    `SELECT MAX(LEN(compte)) AS n FROM prismaCompta_PlanComptableEntrepriseAvecSolde`
  );
  return rows[0]?.n ?? 6;
}

function padCompte(compte: string, length: number): string {
  const trimmed = compte.trim();
  return trimmed.length >= length ? trimmed : trimmed.padEnd(length, '0');
}

/**
 * GET /api/comptes?idClient=&search=&classe=
 * Liste avec soldes (vue prismaCompta_PlanComptableEntrepriseAvecSolde).
 */
planComptableRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { search, classe } = z
      .object({ search: z.string().optional(), classe: z.string().max(2).optional() })
      .parse(req.query);

    const rows = await query(
      `SELECT Compte              AS compte,
              [Libellé]           AS libelle,
              [Débit]             AS debit,
              [Crédit]            AS credit,
              Solde               AS solde,
              idCentralisateur    AS idCentralisateur,
              displayMember       AS displayMember,
              IsAnalytique        AS isAnalytique,
              isCompteInActif     AS isCompteInActif,
              CASE WHEN idCentralisateur = 0 THEN 'COMPTE' ELSE 'TIERS' END AS type
         FROM prismaCompta_PlanComptableEntrepriseAvecSolde
        WHERE idClient = @idClient
          AND (@search IS NULL OR Compte LIKE @search + '%' OR [Libellé] LIKE '%' + @search + '%')
          AND (@classe IS NULL OR LEFT(Compte, LEN(@classe)) = @classe)
        ORDER BY Compte`,
      { idClient, search: search ?? null, classe: classe ?? null }
    );
    res.json(rows);
  })
);

/**
 * GET /api/comptes/lookup?idClient=&q=
 * Recherche légère pour la saisie (vue prismaCompta_planComptable, comptes + tiers).
 */
planComptableRouter.get(
  '/lookup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const { q } = z.object({ q: z.string().optional() }).parse(req.query);
    // Recherche multi-mots : chaque mot doit figurer dans le n° de compte OU le
    // libellé (« contient », pas seulement le début). Ex. « bmw » ne garde que BMW ;
    // « sarl bardier » trouve le bon tiers quel que soit l'ordre des mots.
    const termes = (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const params: Record<string, unknown> = { idClient };
    const conds = termes
      .map((t, i) => {
        params[`t${i}`] = t;
        return `(compte LIKE @t${i} + '%' OR libelle LIKE '%' + @t${i} + '%')`;
      })
      .join(' AND ');
    const filtre = termes.length ? `AND ${conds}` : '';
    // DISTINCT : la vue prismaCompta_planComptable peut renvoyer des doublons.
    const rows = await query(
      `SELECT DISTINCT TOP 50
              LTRIM(RTRIM(compte))  AS compte,
              LTRIM(RTRIM(libelle)) AS libelle,
              displayMember         AS displayMember,
              idCentralisateur      AS idCentralisateur,
              isAnalytique          AS isAnalytique
         FROM prismaCompta_planComptable
        WHERE (idClient = @idClient OR idClient IS NULL)
          ${filtre}
        ORDER BY compte`,
      params
    );
    res.json(rows);
  })
);

/** Classes présentes (pour construire les onglets par classe). */
planComptableRouter.get(
  '/classes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const rows = await query<{ classe: string }>(
      `SELECT DISTINCT LEFT(compte, 1) AS classe
         FROM prismaCompta_planComptable
        WHERE idClient = @idClient
        ORDER BY classe`,
      { idClient }
    );
    res.json(rows.map((r) => r.classe).filter(Boolean));
  })
);

const compteBody = z.object({
  compte: z.string().min(1).max(25),
  libelle: z.string().min(1).max(200),
  isAnalytique: z.boolean().optional().default(false),
  isCompteInActif: z.boolean().optional().default(false),
  codeTVA: z.number().int().nullish(),
  compteAuxiliaire: z.string().max(25).nullish(),
});

/** POST /api/comptes?idClient= — création (table prismaCompta_PCG). */
planComptableRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const body = compteBody.parse(req.body);
    const compte = padCompte(body.compte, await getLongueurCompte());

    const existing = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM prismaCompta_PCG WHERE compte = @compte AND idClient = @idClient`,
      { compte, idClient }
    );
    if ((existing[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `Le compte « ${compte} » existe déjà pour cet exercice.`);
    }

    await query(
      `INSERT INTO prismaCompta_PCG (compte, libelle, isAnalytique, isCompteInActif, codeTVA, compteAuxiliaire, idClient)
       VALUES (@compte, @libelle, @isAnalytique, @isCompteInActif, @codeTVA, @compteAuxiliaire, @idClient)`,
      {
        compte,
        libelle: body.libelle,
        isAnalytique: body.isAnalytique,
        isCompteInActif: body.isCompteInActif,
        codeTVA: body.codeTVA ?? null,
        compteAuxiliaire: body.compteAuxiliaire ?? null,
        idClient,
      }
    );
    res.status(201).json({ ok: true, compte });
  })
);

/** PUT /api/comptes/:compte?idClient= — mise à jour. */
planComptableRouter.put(
  '/:compte',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const compte = req.params.compte;
    const body = compteBody.omit({ compte: true }).parse(req.body);

    const result = await query<{ n: number }>(
      `UPDATE prismaCompta_PCG
          SET libelle = @libelle,
              isAnalytique = @isAnalytique,
              isCompteInActif = @isCompteInActif,
              codeTVA = @codeTVA,
              compteAuxiliaire = @compteAuxiliaire
        WHERE compte = @compte AND idClient = @idClient;
       SELECT @@ROWCOUNT AS n;`,
      {
        compte,
        libelle: body.libelle,
        isAnalytique: body.isAnalytique,
        isCompteInActif: body.isCompteInActif,
        codeTVA: body.codeTVA ?? null,
        compteAuxiliaire: body.compteAuxiliaire ?? null,
        idClient,
      }
    );
    if ((result[0]?.n ?? 0) === 0) throw new HttpError(404, 'Compte introuvable.');
    res.json({ ok: true });
  })
);

/** DELETE /api/comptes/:compte?idClient= — suppression avec garde-fou. */
planComptableRouter.delete(
  '/:compte',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const compte = req.params.compte;

    const used = await query<{ n: number }>(
      `SELECT COUNT(id) AS n FROM prismaCompta_ecritureLigne
        WHERE comptePCClient = @compte AND idClientLigne = @idClient`,
      { compte, idClient: String(idClient) }
    );
    if ((used[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `Impossible de supprimer : le compte « ${compte} » est mouvementé (${used[0].n} ligne(s)).`);
    }

    await query(`DELETE FROM prismaCompta_PCG WHERE compte = @compte AND idClient = @idClient`, { compte, idClient });
    res.json({ ok: true });
  })
);
