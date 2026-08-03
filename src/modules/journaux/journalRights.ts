import { query } from '../../db/pool.js';

/**
 * Réimplémente ClassStatic.getFiltreUtilisateurJournal : renvoie la liste des
 * codes journaux INTERDITS pour l'utilisateur (droits gérés dans
 * prismaCompta_journal_utilisateur, résolution de groupe via
 * PrismaGestionCo_personne.idPersonneGroupe).
 *
 * Renvoie un tableau de codes journaux à exclure. Si l'utilisateur n'a aucune
 * restriction, renvoie [].
 */
export async function getJournauxExclus(userId: number): Promise<string[]> {
  try {
    const rows = await query<{ CodeJournal: string }>(
      `SELECT ju.CodeJournal
         FROM prismaCompta_journal_utilisateur ju
        WHERE ju.idUtilisateur = ISNULL(
                (SELECT idPersonneGroupe FROM PrismaGestionCo_personne WHERE id = @userId),
                @userId)`,
      { userId }
    );
    return rows.map((r) => r.CodeJournal).filter(Boolean);
  } catch {
    // En cas d'absence des tables de droits, ne rien exclure (comportement legacy tolérant).
    return [];
  }
}
