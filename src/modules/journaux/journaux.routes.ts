import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';
import { getJournauxExclus } from './journalRights.js';

export const journauxRouter = Router();

/** Types de journaux — enum applicatif figé (repris de ucListeJournaux.cs). */
export const TYPES_JOURNAL = [
  { code: 'ACH', libelle: 'ACHAT' },
  { code: 'AN', libelle: 'A NOUVEAUX' },
  { code: 'VTE', libelle: 'VENTE' },
  { code: 'BQE', libelle: 'BANQUE' },
  { code: 'REL', libelle: 'RELEVE' },
  { code: 'EAR', libelle: 'EFFETS A RECEVOIR' },
  { code: 'EAP', libelle: 'EFFETS A PAYER' },
  { code: 'CAE', libelle: 'CHEQUE A ENCAISSER' },
  { code: 'CAI', libelle: 'CAISSE' },
  { code: 'OD', libelle: 'OPERATIONS DIVERSES' },
  { code: 'EFF', libelle: 'EFFET' },
  { code: 'NC', libelle: 'NON COMMUNIQUE' },
  { code: 'IMP', libelle: 'IMPAYE' },
] as const;

const TYPE_CODES = TYPES_JOURNAL.map((t) => t.code);

interface JournalRow {
  code: string;
  libelle: string | null;
  typeJournal: string | null;
  compteBanqueRattache: string | null;
  isExtraComptable: boolean | null;
  idDeviseJournal: number | null;
  isBloqueModification: boolean | null;
  idClient: number;
}

const idClientQuery = z.object({ idClient: z.coerce.number().int() });

const journalBody = z.object({
  code: z.string().min(1).max(25),
  libelle: z.string().min(1).max(100),
  typeJournal: z.enum(TYPE_CODES as [string, ...string[]]),
  compteBanqueRattache: z.string().max(25).nullish(),
  isExtraComptable: z.boolean().optional().default(false),
  idDeviseJournal: z.number().int().nullish(),
});

/** GET /api/journaux/types — la liste figée des types. */
journauxRouter.get('/types', requireAuth, (_req, res) => {
  res.json(TYPES_JOURNAL);
});

/** GET /api/journaux?idClient= — journaux de l'exercice, filtrés par droits utilisateur. */
journauxRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const rows = await query<JournalRow>(
      `SELECT code, libelle, typeJournal, compteBanqueRattache, isExtraComptable,
              idDeviseJournal, isBloqueModification, idClient
         FROM prismaCompta_journal
        WHERE idClient = @idClient
        ORDER BY code`,
      { idClient }
    );
    const exclus = new Set(await getJournauxExclus(req.user!.userId));
    res.json(rows.filter((r) => !exclus.has(r.code)));
  })
);

/** POST /api/journaux?idClient= — création. */
journauxRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const body = journalBody.parse(req.body);

    const existing = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM prismaCompta_journal WHERE code = @code AND idClient = @idClient`,
      { code: body.code, idClient }
    );
    if ((existing[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `Le journal « ${body.code} » existe déjà pour cet exercice.`);
    }

    await query(
      `INSERT INTO prismaCompta_journal
         (code, libelle, typeJournal, compteBanqueRattache, isExtraComptable, idDeviseJournal, idClient)
       VALUES (@code, @libelle, @typeJournal, @compteBanqueRattache, @isExtraComptable, @idDeviseJournal, @idClient)`,
      {
        code: body.code,
        libelle: body.libelle,
        typeJournal: body.typeJournal,
        compteBanqueRattache: body.compteBanqueRattache ?? null,
        isExtraComptable: body.isExtraComptable,
        idDeviseJournal: body.idDeviseJournal ?? null,
        idClient,
      }
    );
    res.status(201).json({ ok: true });
  })
);

/** PUT /api/journaux/:code?idClient= — mise à jour (hors renommage du code). */
journauxRouter.put(
  '/:code',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const code = req.params.code;
    const body = journalBody.omit({ code: true }).parse(req.body);

    const result = await query<{ n: number }>(
      `UPDATE prismaCompta_journal
          SET libelle = @libelle,
              typeJournal = @typeJournal,
              compteBanqueRattache = @compteBanqueRattache,
              isExtraComptable = @isExtraComptable,
              idDeviseJournal = @idDeviseJournal
        WHERE code = @code AND idClient = @idClient;
       SELECT @@ROWCOUNT AS n;`,
      {
        code,
        libelle: body.libelle,
        typeJournal: body.typeJournal,
        compteBanqueRattache: body.compteBanqueRattache ?? null,
        isExtraComptable: body.isExtraComptable,
        idDeviseJournal: body.idDeviseJournal ?? null,
        idClient,
      }
    );
    if ((result[0]?.n ?? 0) === 0) throw new HttpError(404, 'Journal introuvable.');
    res.json({ ok: true });
  })
);

/** DELETE /api/journaux/:code?idClient= — suppression avec garde-fou. */
journauxRouter.delete(
  '/:code',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient } = idClientQuery.parse(req.query);
    const code = req.params.code;

    const used = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM prismaCompta_ecriture WHERE codeJournal = @code AND idClient = @idClient`,
      { code, idClient }
    );
    if ((used[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `Impossible de supprimer : le journal « ${code} » est utilisé par ${used[0].n} écriture(s).`);
    }

    await query(`DELETE FROM prismaCompta_journal WHERE code = @code AND idClient = @idClient`, { code, idClient });
    res.json({ ok: true });
  })
);
