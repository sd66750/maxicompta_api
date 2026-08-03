import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { query } from '../../db/pool.js';

export const etatsRouter = Router();

/**
 * Requête « balanceDetail » reprise à l'identique du legacy (ComptaDataSet.xsd) :
 * lignes d'écriture d'un compte sur la période + ligne « Report à nouveau »
 * (report d'ouverture) en union. Paramètres : @datedebut, @datefin, @idClient,
 * @avecExtraComptable, @compte.
 */
const BALANCE_DETAIL_SQL = `
SELECT
  prismaCompta_ecritureLigne.dateEcheanceLigne as dateEcheance,
  prismaCompta_ecritureLigne.codeJournalLigne as codeJournal,
  convert(varchar(255),prismaCompta_ecritureLigne.id ) AS idLigne,
  convert(varchar(255),prismaCompta_ecritureLigne.idEcriture) as id ,
  prismaCompta_ecritureLigne.pieceLigne as piece,
  prismaCompta_ecritureLigne.dateEcritureLigne AS dateEcriture,
  prismaCompta_planComptable.displayMember as comptePCClient,
  prismaCompta_ecritureLigne.libelle+ case when prismaCompta_ecritureLigne.pieceLIgne like '411%' then ' ('+(SELECT top 1 libelle FROM prismaCompta_PCG where compte=pieceLigne)+')' else '' end as libelle,
  CASE WHEN sens = 1 THEN NULL ELSE montant END AS debit,
  CASE WHEN sens = -1 THEN NULL ELSE montant END AS credit,
  prismaCompta_ecritureLigne.montant * prismaCompta_ecritureLigne.sens AS solde,
  prismaCompta_ecritureLigne.lettrage,
  prismaCompta_ecritureLigne.importation
FROM
  prismaCompta_ecritureLigne
  inner join prismaCompta_planComptable on comptePCCLient = prismaCompta_planComptable.compte and isnull(idTiersCentralisateur, case when comptePCCLient like '411%' then 1 when comptePCCLient like '401%' then 2 else 0 end) = idCentralisateur and (idClientLigne=prismaCompta_planComptable.idClient or prismaCompta_planComptable.idClient is null)
  inner join prismaCompta_journal on codeJournalLigne = prismaCompta_journal.code and prismaCompta_journal.idClient =@idClient and ((isnull(isExtraComptable,0) =0 and  @avecExtraComptable=0) or (@avecExtraComptable=1))
WHERE
  (dateEcritureLigne BETWEEN @datedebut AND @datefin) AND (prismaCompta_ecritureLIgne.idClientLigne = @idClient)
  and prismaCompta_planComptable.displayMember=@compte
union
SELECT
  null as dateEcheance,
  (SELECT top 1 code FROM prismaCompta_journal where typeJournal='AN' and idClient=@idClient) as codeJournal,
  left(case when comptePCClient like '6%' or comptePCClient like '7%' then '12000000' else prismaCompta_ecritureLigne.comptePCClient end,8)*-10  AS idLigne,
  left(case when comptePCClient like '6%' or comptePCClient like '7%' then '12000000' else prismaCompta_ecritureLigne.comptePCClient end,8)*-10 as id ,
  'RAN SIMUL' as piece,
  @datedebut AS dateEcriture,
  prismaCompta_planComptable.displayMember,
  'Report à nouveau simulation' as libelle,
  sum(CASE WHEN sens = 1 THEN NULL ELSE montant END) AS debit,
  sum(CASE WHEN sens = -1 THEN NULL ELSE montant END) AS credit,
  sum(prismaCompta_ecritureLigne.montant * prismaCompta_ecritureLigne.sens) AS solde,
  null lettrage,
  1 importation
FROM prismaCompta_ecritureLigne
  inner join prismaCompta_planComptable on  prismaCompta_planComptable.compte like case when comptePCClient like '6%' or comptePCClient like '7%' then '12000000' else prismaCompta_ecritureLigne.comptePCClient end+'%' and isnull(idTiersCentralisateur, case when comptePCCLient like '411%' then 1 when comptePCCLient like '401%' then 2 else 0 end)= idCentralisateur and (idClientLigne=prismaCompta_planComptable.idClient or prismaCompta_planComptable.idClient is null)
  inner join prismaCompta_journal on codeJournalLigne = prismaCompta_journal.code and prismaCompta_journal.idClient =@idClient and ((isnull(isExtraComptable,0) =0 and  @avecExtraComptable=0) or (@avecExtraComptable=1))
WHERE
  (convert(date,dateEcritureLigne) BETWEEN convert(date,(SELECT exerciceDebut FROM prismaCompta_client where id=@idClient)) AND convert(date,dateadd(day,-1,@datedebut))) AND (prismaCompta_ecritureLIgne.idClientLigne = @idClient)
  and case when comptePCClient like '6%' or comptePCClient like '7%' then '12000000' else prismaCompta_ecritureLigne.comptePCClient end=@compte
  and month(@datedebut) = month((SELECT exerciceDebut FROM prismaCompta_client where id=@idClient)) and day(@dateDebut)=day((SELECT exerciceDebut FROM prismaCompta_client where id=@idClient))
group by prismaCompta_planComptable.displayMember,case when comptePCClient like '6%' or comptePCClient like '7%' then '12000000' else prismaCompta_ecritureLigne.comptePCClient end
`;

const baseSchema = z.object({
  idClient: z.coerce.number().int(),
  dateDebut: z.coerce.date(),
  dateFin: z.coerce.date(),
  extraComptable: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
});

/** Borne les dates comme le legacy : début à 00:00:00, fin à 23:59:50. */
function bornes(dateDebut: Date, dateFin: Date) {
  const debut = new Date(dateDebut);
  debut.setHours(0, 0, 0, 0);
  const fin = new Date(dateFin);
  fin.setHours(23, 59, 50, 0);
  return { debut, fin };
}

/** Liste des racines centralisatrices (tiers), pour @listeCentralisateur. */
async function listeCentralisateurs(): Promise<string> {
  try {
    const rows = await query<{ racine: string }>(`SELECT racine FROM prismaCompta_tiersCentralisateur`);
    return rows.map((r) => r.racine).filter(Boolean).join(',');
  } catch {
    return '';
  }
}

/**
 * GET /api/etats/balance
 * Balance générale — appelle la procédure stockée legacy prismaCompta_balanceCentralisee.
 */
etatsRouter.get(
  '/balance',
  requireAuth,
  asyncHandler(async (req, res) => {
    const p = baseSchema.parse(req.query);
    const { centralise, compteSpecial } = z
      .object({
        centralise: z.union([z.boolean(), z.string()]).optional().transform((v) => v === undefined || v === true || v === 'true' || v === '1'),
        compteSpecial: z.string().optional(),
      })
      .parse(req.query);

    const { debut, fin } = bornes(p.dateDebut, p.dateFin);
    const listeCentralisateur = centralise ? await listeCentralisateurs() : '';

    const rows = await query(
      `EXEC dbo.prismaCompta_balanceCentralisee
         @datedebut = @datedebut,
         @dateFin = @dateFin,
         @idClient = @idClient,
         @listeCentralisateur = @listeCentralisateur,
         @compteSpecial = @compteSpecial,
         @avecExtraComptable = @avecExtraComptable`,
      {
        datedebut: debut,
        dateFin: fin,
        idClient: String(p.idClient),
        listeCentralisateur,
        compteSpecial: compteSpecial ?? '',
        avecExtraComptable: p.extraComptable ? 1 : 0,
      }
    );
    res.json(rows);
  })
);

/**
 * GET /api/etats/balance-agee?idClient=&tiers=411|401&date=YYYY-MM-DD
 * Balance âgée (échéancier des créances/dettes par tranches de jours après
 * échéance) — appelle la procédure stockée legacy PrismaCompta_BalanceAgee.
 * Colonnes : compte, lib ("CODE - Tiers"), solde, c0, c30, c60, c90, c91.
 */
etatsRouter.get(
  '/balance-agee',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { idClient, tiers, date } = z
      .object({
        idClient: z.coerce.number().int(),
        tiers: z.enum(['411', '401']),
        date: z.coerce.date(),
      })
      .parse(req.query);

    const rows = await query(
      `EXEC PrismaCompta_BalanceAgee
         @filtreCompteTiers = @tiers,
         @idClientExercice  = @idClient,
         @dateButtoir       = @date`,
      { tiers, idClient, date }
    );
    res.json(rows);
  })
);

/**
 * GET /api/etats/grand-livre/detail — lignes détaillées d'un compte (Grand Livre),
 * requête balanceDetail à l'identique. Le solde progressif est calculé côté client.
 */
etatsRouter.get(
  '/grand-livre/detail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const p = baseSchema.parse(req.query);
    const { compte } = z.object({ compte: z.string().min(1) }).parse(req.query);
    const { debut, fin } = bornes(p.dateDebut, p.dateFin);

    const rows = await query(BALANCE_DETAIL_SQL, {
      datedebut: debut,
      datefin: fin,
      idClient: p.idClient,
      avecExtraComptable: p.extraComptable ? 1 : 0,
      compte,
    });
    // Report à nouveau (RAN) en tête, puis lignes par date.
    rows.sort((a, b) => {
      const ra = (a as { piece?: string }).piece === 'RAN SIMUL' ? 0 : 1;
      const rb = (b as { piece?: string }).piece === 'RAN SIMUL' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return new Date((a as { dateEcriture: string }).dateEcriture).getTime() - new Date((b as { dateEcriture: string }).dateEcriture).getTime();
    });
    res.json(rows);
  })
);
