import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const clotureExerciceRouter = Router();

/**
 * Clôture d'exercice. Opération SENSIBLE et irréversible (hors déclôture) :
 * crée l'exercice suivant, duplique journaux + plan comptable, bascule les
 * écritures de la nouvelle période, génère les à-nouveaux (RAN) et l'écriture
 * de résultat. On APPELLE les procédures legacy existantes pour un comportement
 * strictement identique à PrismaSoft (aucune logique réimplémentée) :
 *   - prismaCompta_CreationParametrageRAN(idClient)  : (ré)initialise le paramétrage
 *   - prismaCompta_clotureExercice(idExercice, compteResultat)
 *   - prismaCompta_decloture(idOld, idNew)
 */

const ACTIONS = ['Solder toutes les écritures', 'Reporter uniquement les écritures non lettrées', 'Reporter toutes les écritures'] as const;

/** Retrouve l'exercice suivant créé par la clôture (même société, débute le lendemain de la fin). */
async function idExerciceSuivant(idClient: number): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT n.id
       FROM prismaCompta_client c
       JOIN prismaCompta_client n
         ON n.idSociete = c.idSociete
        AND CONVERT(date, n.exerciceDebut) = CONVERT(date, DATEADD(day, 1, c.exerciceFin))
      WHERE c.id = @idClient`,
    { idClient }
  );
  return r[0]?.id ?? null;
}

/** GET /api/cloture-exercice/controles?idClient= — état de l'exercice avant clôture. */
clotureExerciceRouter.get(
  '/controles',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const cli = await query<{ nom: string; isCloture: boolean; exerciceDebut: string; exerciceFin: string }>(
      `SELECT nom, ISNULL(isCloture,0) AS isCloture, exerciceDebut, exerciceFin FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    if (!cli[0]) throw new HttpError(404, 'Exercice introuvable.');
    const bal = await query<{ debit: number; credit: number; nb: number }>(
      `SELECT ISNULL(SUM(CASE WHEN sens=-1 THEN montant ELSE 0 END),0) AS debit,
              ISNULL(SUM(CASE WHEN sens= 1 THEN montant ELSE 0 END),0) AS credit,
              COUNT(*) AS nb
         FROM prismaCompta_ecritureLigne WHERE idClientLigne = @idClient`,
      { idClient }
    );
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const totalDebit = round2(Number(bal[0]?.debit) || 0);
    const totalCredit = round2(Number(bal[0]?.credit) || 0);

    // Résultat = produits (classe 7) - charges (classe 6) = SUM(montant*sens),
    // hors journaux extra-comptables (comme la procédure de clôture).
    // > 0 : bénéfice (résultat créditeur) ; < 0 : perte (résultat débiteur).
    const resRows = await query<{ resultat: number }>(
      `SELECT ISNULL(SUM(montant * sens), 0) AS resultat
         FROM prismaCompta_ecritureLigne l
        WHERE l.idClientLigne = @idClient
          AND (l.comptePCClient LIKE '6%' OR l.comptePCClient LIKE '7%')
          AND l.codeJournalLigne NOT IN (SELECT code FROM prismaCompta_journal WHERE ISNULL(isExtraComptable,0)=1 AND idClient = @idClient)`,
      { idClient }
    );
    const resultat = round2(Number(resRows[0]?.resultat) || 0);
    const suivant = await idExerciceSuivant(idClient);
    res.json({
      nom: cli[0].nom,
      isCloture: !!cli[0].isCloture,
      exerciceDebut: cli[0].exerciceDebut,
      exerciceFin: cli[0].exerciceFin,
      totalDebit,
      totalCredit,
      equilibre: round2(totalDebit - totalCredit) === 0,
      nbLignes: Number(bal[0]?.nb) || 0,
      resultat,
      resultatSens: resultat < 0 ? 'debiteur' : 'crediteur',
      idExerciceSuivant: suivant,
    });
  })
);

/** GET /api/cloture-exercice/parametrage?idClient= — règles de report des à-nouveaux par compte. */
clotureExerciceRouter.get(
  '/parametrage',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.coerce.number().int() }).parse(req.query);
    const rows = await query(
      `SELECT id, LTRIM(RTRIM(compte)) AS compte, solde, [action] FROM prismaCompta_parametrageRAN WHERE idClient = @idClient ORDER BY compte`,
      { idClient }
    );
    res.json(rows);
  })
);

/** POST /api/cloture-exercice/parametrage/init — (ré)initialise le paramétrage RAN (procédure legacy). */
clotureExerciceRouter.post(
  '/parametrage/init',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.number().int() }).parse(req.body);
    await query(`EXEC prismaCompta_CreationParametrageRAN @idClient = @idClient`, { idClient });
    res.json({ ok: true });
  })
);

/** PUT /api/cloture-exercice/parametrage — met à jour l'action de report d'un compte. */
clotureExerciceRouter.put(
  '/parametrage',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, id, action } = z
      .object({ idClient: z.number().int(), id: z.number().int(), action: z.enum(ACTIONS) })
      .parse(req.body);
    await query(
      `UPDATE prismaCompta_parametrageRAN SET [action] = @action WHERE id = @id AND idClient = @idClient`,
      { idClient, id, action }
    );
    res.json({ ok: true });
  })
);

/** POST /api/cloture-exercice/cloturer — clôture l'exercice (appel procédure legacy). */
clotureExerciceRouter.post(
  '/cloturer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, comptePCClientResultat } = z
      .object({ idClient: z.number().int(), comptePCClientResultat: z.string().trim().min(1) })
      .parse(req.body);

    const cli = await query<{ isCloture: boolean }>(
      `SELECT ISNULL(isCloture,0) AS isCloture FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    if (!cli[0]) throw new HttpError(404, 'Exercice introuvable.');
    if (cli[0].isCloture) throw new HttpError(409, 'Cet exercice est déjà clôturé.');

    // Appel de la procédure de clôture (comportement identique à PrismaSoft).
    await query(
      `EXEC prismaCompta_clotureExercice @idExercice = @idClient, @comptePCClientResultat = @compte`,
      { idClient, compte: comptePCClientResultat }
    );
    const idNouvelExercice = await idExerciceSuivant(idClient);
    res.json({ ok: true, idNouvelExercice });
  })
);

/** POST /api/cloture-exercice/decloturer — annule la clôture (appel procédure legacy). */
clotureExerciceRouter.post(
  '/decloturer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = z.object({ idClient: z.number().int() }).parse(req.body);
    const cli = await query<{ isCloture: boolean }>(
      `SELECT ISNULL(isCloture,0) AS isCloture FROM prismaCompta_client WHERE id = @idClient`,
      { idClient }
    );
    if (!cli[0]) throw new HttpError(404, 'Exercice introuvable.');
    if (!cli[0].isCloture) throw new HttpError(409, "Cet exercice n'est pas clôturé.");
    const idNew = await idExerciceSuivant(idClient);
    if (!idNew) throw new HttpError(409, 'Exercice suivant introuvable : déclôture impossible.');
    await query(
      `EXEC prismaCompta_decloture @idEcritureOLD = @old, @idEcritureNew = @new`,
      { old: idClient, new: idNew }
    );
    res.json({ ok: true });
  })
);
