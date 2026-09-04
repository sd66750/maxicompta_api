import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const resultatMensuelRouter = Router();

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

interface LigneCompte {
  compte: string;
  libelle: string;
  valeurs: number[]; // 12 mois, dans l'ordre de l'exercice
  total: number;
}

/**
 * GET /api/resultat-mensuel?idClient=
 *
 * Compte de résultat éclaté par mois. Lignes = comptes de classe 7 (produits)
 * puis classe 6 (charges) ; colonnes = les 12 mois de l'exercice, ordonnés à
 * partir de `exerciceDebut` (gère les exercices décalés) + total de l'exercice.
 *
 * Conventions : charges (classe 6) affichées en POSITIF ; Résultat = Produits −
 * Charges (= SUM(montant*sens), > 0 = bénéfice). Hors journaux extra-comptables.
 * Aucun à-nouveau : les comptes de résultat repartent de 0 chaque exercice.
 */
resultatMensuelRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);

    // 1. Exercice : libellé + bornes + mois/année de début (pour ordonner les colonnes).
    const ent = await query<{
      nom: string | null;
      nomImpression: string | null;
      exerciceDebut: string | null;
      exerciceFin: string | null;
      anneeDebut: number | null;
      moisDebut: number | null;
    }>(
      `SELECT nom, nomImpression, exerciceDebut, exerciceFin,
              YEAR(exerciceDebut) AS anneeDebut, MONTH(exerciceDebut) AS moisDebut
         FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    const e = ent[0];
    if (!e) throw new HttpError(404, 'Exercice introuvable.');

    const anneeDebut = Number(e.anneeDebut) || new Date().getFullYear();
    const moisDebut = Number(e.moisDebut) || 1; // 1..12

    // 2. Les 12 colonnes de mois, à partir du début d'exercice.
    const mois = Array.from({ length: 12 }, (_, i) => {
      const offset = moisDebut - 1 + i; // 0-based, peut dépasser 11
      const m = offset % 12; // 0..11
      const annee = anneeDebut + Math.floor(offset / 12);
      return { annee, mois: m + 1, label: `${MOIS_COURTS[m]} ${annee}` };
    });
    const idxByKey = new Map(mois.map((m, i) => [`${m.annee}-${m.mois}`, i]));

    // 3. Sommes signées par compte × mois (classes 6/7, hors extra-comptable).
    //    SUM(montant*sens) = crédit − débit : produit > 0, charge < 0.
    const rows = await query<{ compte: string; annee: number; mois: number; soldeSigne: number }>(
      `SELECT LTRIM(RTRIM(l.comptePCClient)) AS compte,
              YEAR(l.dateEcritureLigne)      AS annee,
              MONTH(l.dateEcritureLigne)     AS mois,
              SUM(l.montant * l.sens)        AS soldeSigne
         FROM prismaCompta_ecritureLigne l
        WHERE l.idClientLigne = @idClient
          AND (l.comptePCClient LIKE '6%' OR l.comptePCClient LIKE '7%')
          AND l.codeJournalLigne NOT IN (
                SELECT code FROM prismaCompta_journal
                 WHERE ISNULL(isExtraComptable, 0) = 1 AND idClient = @idClient)
        GROUP BY LTRIM(RTRIM(l.comptePCClient)), YEAR(l.dateEcritureLigne), MONTH(l.dateEcritureLigne)`,
      { idClient }
    );

    // 4. Libellés des comptes (dédoublonnés).
    const labelRows = await query<{ compte: string; libelle: string | null }>(
      `SELECT LTRIM(RTRIM(compte)) AS compte, MIN(LTRIM(RTRIM(libelle))) AS libelle
         FROM prismaCompta_planComptable
        WHERE (idClient = @idClient OR idClient IS NULL)
          AND (compte LIKE '6%' OR compte LIKE '7%')
        GROUP BY LTRIM(RTRIM(compte))`,
      { idClient }
    );
    const libByCompte = new Map(labelRows.map((r) => [r.compte, (r.libelle ?? '').trim()]));

    // 5. Pivot par compte → 12 valeurs mensuelles (produits et charges en positif).
    const comptes = new Map<string, { classe: string; valeurs: number[] }>();
    for (const r of rows) {
      const idx = idxByKey.get(`${Number(r.annee)}-${Number(r.mois)}`);
      if (idx === undefined) continue; // hors des 12 mois de l'exercice (sécurité)
      const compte = r.compte;
      if (!compte) continue;
      const classe = compte[0];
      const signe = Number(r.soldeSigne) || 0; // crédit − débit
      const valeur = classe === '6' ? -signe : signe; // charges & produits en positif
      let c = comptes.get(compte);
      if (!c) {
        c = { classe, valeurs: new Array(12).fill(0) };
        comptes.set(compte, c);
      }
      c.valeurs[idx] = round2(c.valeurs[idx] + valeur);
    }

    // 6. Lignes par classe (seulement les comptes mouvementés), triées par n° de compte.
    const lignesDeClasse = (classe: string): LigneCompte[] =>
      [...comptes.entries()]
        .filter(([, c]) => c.classe === classe)
        .map(([compte, c]) => ({
          compte,
          libelle: libByCompte.get(compte) ?? '',
          valeurs: c.valeurs.map(round2),
          total: round2(c.valeurs.reduce((s, v) => s + v, 0)),
        }))
        .filter((l) => l.total !== 0 || l.valeurs.some((v) => v !== 0))
        .sort((a, b) => a.compte.localeCompare(b.compte));

    const produits = lignesDeClasse('7');
    const charges = lignesDeClasse('6');

    // 7. Totaux colonne par colonne.
    const sommeColonnes = (lignes: LigneCompte[]): number[] => {
      const v = new Array(12).fill(0);
      for (const l of lignes) for (let i = 0; i < 12; i++) v[i] = round2(v[i] + l.valeurs[i]);
      return v;
    };
    const totalOf = (v: number[]) => round2(v.reduce((s, x) => s + x, 0));

    const vProduits = sommeColonnes(produits);
    const vCharges = sommeColonnes(charges);
    const vResultat = vProduits.map((p, i) => round2(p - vCharges[i]));

    res.json({
      exercice: {
        id: idClient,
        libelle: (e.nomImpression?.trim() || e.nom?.trim() || ''),
        debut: e.exerciceDebut ?? null,
        fin: e.exerciceFin ?? null,
      },
      mois,
      produits,
      charges,
      totaux: {
        produits: { valeurs: vProduits, total: totalOf(vProduits) },
        charges: { valeurs: vCharges, total: totalOf(vCharges) },
        resultat: { valeurs: vResultat, total: totalOf(vResultat) },
      },
    });
  })
);
