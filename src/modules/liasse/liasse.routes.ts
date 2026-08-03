import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const liasseRouter = Router();

/**
 * Liasse (bilan + compte de résultat) calculée à partir des soldes par compte
 * de l'exercice, regroupés selon le plan comptable général (présentation
 * système développé, proche des tableaux 2050-2053). Pas de mapping CERFA
 * détaillé par case : regroupement par grandes rubriques.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

interface SoldeCompte { compte: string; solde: number }

/** Rubriques de l'actif (brut / amortissement / net), dans l'ordre d'affichage. */
const ACTIF = [
  'Immobilisations incorporelles',
  'Immobilisations corporelles',
  'Immobilisations financières',
  'Stocks et en-cours',
  'Créances clients et comptes rattachés',
  'Autres créances',
  'Valeurs mobilières de placement',
  'Disponibilités',
  "Charges constatées d'avance",
] as const;
const ACTIF_IMMO = new Set(['Immobilisations incorporelles', 'Immobilisations corporelles', 'Immobilisations financières']);

const PASSIF = [
  'Capital',
  'Primes, réserves, report à nouveau',
  "Résultat de l'exercice",
  "Subventions d'investissement et provisions réglementées",
  'Provisions pour risques et charges',
  'Emprunts et dettes financières',
  'Dettes fournisseurs et comptes rattachés',
  'Dettes fiscales et sociales',
  'Autres dettes',
  "Produits constatés d'avance",
] as const;
const PASSIF_CP = new Set(['Capital', 'Primes, réserves, report à nouveau', "Résultat de l'exercice", "Subventions d'investissement et provisions réglementées"]);

/** Ventile un compte de bilan (classes 1-5) vers une rubrique. */
function ventilerBilan(c: string, solde: number): { rubrique: string; col: 'brut' | 'amort' | 'passif' } | null {
  const d2 = c.slice(0, 2);
  const d3 = c.slice(0, 3);
  // Amortissements et dépréciations (réduisent le brut de l'actif).
  if (d2 === '28' || d2 === '29') {
    const rub = d3 === '280' || d3 === '290' ? 'Immobilisations incorporelles'
      : d3 === '296' || d3 === '297' ? 'Immobilisations financières'
      : 'Immobilisations corporelles';
    return { rubrique: rub, col: 'amort' };
  }
  if (d2 === '39') return { rubrique: 'Stocks et en-cours', col: 'amort' };
  if (d2 === '49') return { rubrique: d3 === '491' ? 'Créances clients et comptes rattachés' : 'Autres créances', col: 'amort' };
  if (d2 === '59') return { rubrique: 'Valeurs mobilières de placement', col: 'amort' };

  // Actif immobilisé (brut).
  if (d2 === '20') return { rubrique: 'Immobilisations incorporelles', col: 'brut' };
  if (d2 === '21' || d2 === '22' || d2 === '23') return { rubrique: 'Immobilisations corporelles', col: 'brut' };
  if (d2 === '26' || d2 === '27') return { rubrique: 'Immobilisations financières', col: 'brut' };
  if (c[0] === '3') return { rubrique: 'Stocks et en-cours', col: 'brut' };

  // Classe 5 (financier), hors dépréciation, décidé par le signe.
  if (c[0] === '5') {
    if (d2 === '50') return { rubrique: 'Valeurs mobilières de placement', col: 'brut' };
    if (solde >= 0) return { rubrique: 'Disponibilités', col: 'brut' };
    return { rubrique: 'Emprunts et dettes financières', col: 'passif' }; // découvert / concours
  }

  // Capitaux propres, provisions, dettes financières (classe 1).
  if (c[0] === '1') {
    if (d2 === '10') return { rubrique: d3 === '101' || d3 === '108' ? 'Capital' : 'Primes, réserves, report à nouveau', col: 'passif' };
    if (d2 === '11' || d2 === '12') return { rubrique: 'Primes, réserves, report à nouveau', col: 'passif' };
    if (d2 === '13' || d2 === '14') return { rubrique: "Subventions d'investissement et provisions réglementées", col: 'passif' };
    if (d2 === '15') return { rubrique: 'Provisions pour risques et charges', col: 'passif' };
    return { rubrique: 'Emprunts et dettes financières', col: 'passif' }; // 16,17,18
  }

  // Comptes de tiers (classe 4, hors dépréciation) : actif si débiteur, passif si créditeur.
  if (c[0] === '4') {
    if (solde >= 0) {
      // Créance (actif brut)
      if (d2 === '41') return { rubrique: 'Créances clients et comptes rattachés', col: 'brut' };
      if (d3 === '486') return { rubrique: "Charges constatées d'avance", col: 'brut' };
      return { rubrique: 'Autres créances', col: 'brut' };
    }
    // Dette (passif)
    if (d2 === '40') return { rubrique: 'Dettes fournisseurs et comptes rattachés', col: 'passif' };
    if (d3 === '487') return { rubrique: "Produits constatés d'avance", col: 'passif' };
    if (d2 === '42' || d2 === '43' || d2 === '44') return { rubrique: 'Dettes fiscales et sociales', col: 'passif' };
    return { rubrique: 'Autres dettes', col: 'passif' };
  }
  return null;
}

// Rubriques du compte de résultat 2033-B. Le montant est porté au crédit
// (produit) ou au débit (charge) selon l'appartenance à cet ensemble.
const CR_PRODUITS = new Set([
  'Ventes de marchandises', 'Production vendue (biens et services)', 'Production stockée',
  'Production immobilisée', "Subventions d'exploitation", 'Autres produits',
  'Produits financiers', 'Produits exceptionnels',
]);

/** Ventile un compte de gestion (classes 6-7) vers une rubrique du 2033-B. */
function ventilerResultat(c: string): string | null {
  if (c[0] === '7') {
    if (c.startsWith('707')) return 'Ventes de marchandises';
    if (c.startsWith('70')) return 'Production vendue (biens et services)';
    if (c.startsWith('71')) return 'Production stockée';
    if (c.startsWith('72')) return 'Production immobilisée';
    if (c.startsWith('74')) return "Subventions d'exploitation";
    if (c.startsWith('76') || c.startsWith('786') || c.startsWith('796')) return 'Produits financiers';
    if (c.startsWith('77') || c.startsWith('787') || c.startsWith('797')) return 'Produits exceptionnels';
    return 'Autres produits'; // 75, 781, 791…
  }
  if (c[0] === '6') {
    if (c.startsWith('607') || c.startsWith('6037') || c.startsWith('6087') || c.startsWith('6097')) return 'Achats de marchandises';
    if (c.startsWith('601') || c.startsWith('602') || c.startsWith('6031') || c.startsWith('6032') || c.startsWith('6081') || c.startsWith('6082') || c.startsWith('6091') || c.startsWith('6092')) return 'Achats de matières premières et approvisionnements';
    if (c.startsWith('604') || c.startsWith('605') || c.startsWith('606') || c.startsWith('61') || c.startsWith('62')) return 'Autres achats et charges externes';
    if (c.startsWith('63')) return 'Impôts, taxes et versements assimilés';
    if (c.startsWith('641') || c.startsWith('644') || c.startsWith('648')) return 'Salaires et traitements';
    if (c.startsWith('645') || c.startsWith('646') || c.startsWith('647')) return 'Charges sociales';
    if (c.startsWith('6811') || c.startsWith('6812') || c.startsWith('681')) return 'Dotations aux amortissements';
    if (c.startsWith('6815') || c.startsWith('6816') || c.startsWith('6817')) return 'Dotations aux provisions';
    if (c.startsWith('66') || c.startsWith('686')) return 'Charges financières';
    if (c.startsWith('67') || c.startsWith('687')) return 'Charges exceptionnelles';
    if (c.startsWith('691')) return 'Participation des salariés';
    if (c.startsWith('695') || c.startsWith('698') || c.startsWith('699')) return 'Impôt sur les bénéfices';
    return 'Autres charges'; // 65…
  }
  return null;
}

/** GET /api/liasse?idClient= — bilan + compte de résultat. */
liasseRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);

    const ent = await query<{ nom: string | null; nomImpression: string | null; numSiret: string | null; adresse1: string | null; adresse2: string | null; codePostal: string | null; ville: string | null; exerciceDebut: string; exerciceFin: string }>(
      `SELECT nom, nomImpression, numSiret, adresse1, adresse2, codePostal, ville, exerciceDebut, exerciceFin
         FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    const e = ent[0];
    const entete = {
      nom: e?.nomImpression?.trim() || e?.nom?.trim() || '',
      siret: (e?.numSiret ?? '').trim(),
      siren: (e?.numSiret ?? '').replace(/\D/g, '').slice(0, 9),
      adresse1: (e?.adresse1 ?? '').trim(),
      adresse2: (e?.adresse2 ?? '').trim(),
      codePostal: (e?.codePostal ?? '').trim(),
      ville: (e?.ville ?? '').trim(),
      exerciceDebut: e?.exerciceDebut ?? null,
      exerciceFin: e?.exerciceFin ?? null,
    };

    const rows = await query<{ compte: string; debit: number; credit: number }>(
      `SELECT LTRIM(RTRIM(comptePCClient)) AS compte,
              SUM(CASE WHEN sens = -1 THEN montant ELSE 0 END) AS debit,
              SUM(CASE WHEN sens =  1 THEN montant ELSE 0 END) AS credit
         FROM prismaCompta_ecritureLigne
        WHERE idClientLigne = @idClient
        GROUP BY LTRIM(RTRIM(comptePCClient))`,
      { idClient }
    );
    const soldes: SoldeCompte[] = rows
      .filter((r) => r.compte)
      .map((r) => ({ compte: r.compte, solde: round2(Number(r.debit) - Number(r.credit)) }));

    // --- Compte de résultat (2033-B) ---
    const crMap = new Map<string, number>();
    for (const { compte, solde } of soldes) {
      const rub = ventilerResultat(compte);
      if (!rub) continue;
      const montant = CR_PRODUITS.has(rub) ? -solde : solde; // produit = crédit, charge = débit
      crMap.set(rub, round2((crMap.get(rub) ?? 0) + montant));
    }
    const g = (r: string) => crMap.get(r) ?? 0;
    const PRODUITS_EXPL = ['Ventes de marchandises', 'Production vendue (biens et services)', 'Production stockée', 'Production immobilisée', "Subventions d'exploitation", 'Autres produits'];
    const CHARGES_EXPL = ['Achats de marchandises', 'Achats de matières premières et approvisionnements', 'Autres achats et charges externes', 'Impôts, taxes et versements assimilés', 'Salaires et traitements', 'Charges sociales', 'Dotations aux amortissements', 'Dotations aux provisions', 'Autres charges'];
    const totalProduitsExpl = round2(PRODUITS_EXPL.reduce((s, r) => s + g(r), 0));
    const totalChargesExpl = round2(CHARGES_EXPL.reduce((s, r) => s + g(r), 0));
    const rExpl = round2(totalProduitsExpl - totalChargesExpl);
    const rFin = round2(g('Produits financiers') - g('Charges financières'));
    const rCourant = round2(rExpl + rFin);
    const rExc = round2(g('Produits exceptionnels') - g('Charges exceptionnelles'));
    const participation = g('Participation des salariés');
    const impotBenefices = g('Impôt sur les bénéfices');
    const resultatNet = round2(rCourant + rExc - participation - impotBenefices);
    const totalProduits = round2(totalProduitsExpl + g('Produits financiers') + g('Produits exceptionnels'));
    const totalCharges = round2(totalChargesExpl + g('Charges financières') + g('Charges exceptionnelles') + participation + impotBenefices);

    // Lignes ordonnées du 2033-B (produit / charge / sous-total).
    type LigneCR = { rubrique: string; type: 'produit' | 'charge' | 'sousTotal' | 'total'; montant: number };
    const resultatLignes: LigneCR[] = [
      ...PRODUITS_EXPL.map((r) => ({ rubrique: r, type: 'produit' as const, montant: g(r) })),
      { rubrique: "Total des produits d'exploitation", type: 'sousTotal', montant: totalProduitsExpl },
      ...CHARGES_EXPL.map((r) => ({ rubrique: r, type: 'charge' as const, montant: g(r) })),
      { rubrique: "Total des charges d'exploitation", type: 'sousTotal', montant: totalChargesExpl },
      { rubrique: "RÉSULTAT D'EXPLOITATION", type: 'sousTotal', montant: rExpl },
      { rubrique: 'Produits financiers', type: 'produit', montant: g('Produits financiers') },
      { rubrique: 'Charges financières', type: 'charge', montant: g('Charges financières') },
      { rubrique: 'RÉSULTAT FINANCIER', type: 'sousTotal', montant: rFin },
      { rubrique: 'RÉSULTAT COURANT AVANT IMPÔTS', type: 'sousTotal', montant: rCourant },
      { rubrique: 'Produits exceptionnels', type: 'produit', montant: g('Produits exceptionnels') },
      { rubrique: 'Charges exceptionnelles', type: 'charge', montant: g('Charges exceptionnelles') },
      { rubrique: 'RÉSULTAT EXCEPTIONNEL', type: 'sousTotal', montant: rExc },
      { rubrique: 'Participation des salariés', type: 'charge', montant: participation },
      { rubrique: 'Impôt sur les bénéfices', type: 'charge', montant: impotBenefices },
      { rubrique: 'RÉSULTAT NET (bénéfice ou perte)', type: 'total', montant: resultatNet },
    ];

    // --- Bilan ---
    const actifMap = new Map<string, { brut: number; amort: number }>();
    const passifMap = new Map<string, number>();
    const addActif = (rub: string, col: 'brut' | 'amort', v: number) => {
      const cur = actifMap.get(rub) ?? { brut: 0, amort: 0 };
      cur[col] = round2(cur[col] + v);
      actifMap.set(rub, cur);
    };
    for (const { compte, solde } of soldes) {
      const v = ventilerBilan(compte, solde);
      if (!v) continue;
      if (v.col === 'brut') addActif(v.rubrique, 'brut', solde);
      else if (v.col === 'amort') addActif(v.rubrique, 'amort', -solde); // dépréciation : solde créditeur
      else passifMap.set(v.rubrique, round2((passifMap.get(v.rubrique) ?? 0) + -solde)); // passif : solde créditeur
    }
    // Résultat de l'exercice au passif (capitaux propres).
    passifMap.set("Résultat de l'exercice", round2((passifMap.get("Résultat de l'exercice") ?? 0) + resultatNet));

    const actif = ACTIF.map((rubrique) => {
      const a = actifMap.get(rubrique) ?? { brut: 0, amort: 0 };
      return { rubrique, brut: a.brut, amort: a.amort, net: round2(a.brut - a.amort), immobilise: ACTIF_IMMO.has(rubrique) };
    });
    const passif = PASSIF.map((rubrique) => ({ rubrique, montant: passifMap.get(rubrique) ?? 0, capitauxPropres: PASSIF_CP.has(rubrique) }));

    const totalActif = round2(actif.reduce((s, r) => s + r.net, 0));
    const totalPassif = round2(passif.reduce((s, r) => s + r.montant, 0));

    res.json({
      entete,
      bilan: {
        actif,
        passif,
        totalActif,
        totalPassif,
        totalActifImmobilise: round2(actif.filter((r) => r.immobilise).reduce((s, r) => s + r.net, 0)),
        totalCapitauxPropres: round2(passif.filter((r) => r.capitauxPropres).reduce((s, r) => s + r.montant, 0)),
        ecart: round2(totalActif - totalPassif),
      },
      resultat: {
        lignes: resultatLignes,
        totalProduits,
        totalCharges,
        resultatNet,
      },
    });
  })
);
