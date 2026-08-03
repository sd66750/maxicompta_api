import { query } from '../db/pool.js';
import { HttpError } from '../http/helpers.js';
import { signToken, type SessionUser } from './jwt.js';
import { verifyPassword } from './password.js';

interface UtilisateurRow {
  id: number;
  ident: string | null;
  pass: string | null;
  nom: string | null;
  prenom: string | null;
}

/**
 * Sources d'authentification possibles, essayées dans l'ordre. On reproduit le
 * comportement du login PrismaSoft d'origine :
 *   1. vue PrismaSoft_Authentification_Utilisateur (login/password) — login ERP réel
 *   2. table PrismaGestionCo_personne (identifiant/motDePasse, comptes actifs)
 *   3. table prismaCompta_utilisateur (email/pass) — spécifique Compta
 * Chaque source est protégée : si la table/vue n'existe pas, on passe à la suivante.
 */
const SOURCES: string[] = [
  `SELECT TOP 1 id, login AS ident, password AS pass, NULL AS nom, NULL AS prenom
     FROM PrismaSoft_Authentification_Utilisateur
    WHERE LOWER(LTRIM(RTRIM(login))) = LOWER(LTRIM(RTRIM(@identifiant)))`,
  `SELECT TOP 1 id, identifiant AS ident, motDePasse AS pass, nom, prenom
     FROM PrismaGestionCo_personne
    WHERE LOWER(LTRIM(RTRIM(identifiant))) = LOWER(LTRIM(RTRIM(@identifiant)))
      AND ISNULL(isActif, 1) = 1`,
  `SELECT TOP 1 id, email AS ident, pass, nom, prenom
     FROM prismaCompta_utilisateur
    WHERE LOWER(LTRIM(RTRIM(email))) = LOWER(LTRIM(RTRIM(@identifiant)))`,
];

/**
 * Authentifie l'utilisateur contre les sources connues.
 * Renvoie un JWT de session en cas de succès.
 */
export async function login(identifiant: string, motDePasse: string): Promise<{ token: string; user: SessionUser }> {
  let sourceExisted = false;

  for (const sql of SOURCES) {
    let rows: UtilisateurRow[];
    try {
      rows = await query<UtilisateurRow>(sql, { identifiant });
    } catch {
      // Table/vue absente dans cette base → source suivante.
      continue;
    }
    sourceExisted = true;

    const row = rows[0];
    if (!row) continue; // identifiant absent de cette source

    if (await verifyPassword(row.pass, motDePasse)) {
      const user: SessionUser = {
        userId: row.id,
        login: row.ident ?? identifiant,
        nom: row.nom ?? undefined,
        prenom: row.prenom ?? undefined,
      };
      return { token: signToken(user), user };
    }
    // identifiant trouvé mais mauvais mot de passe → on continue quand même
    // au cas où le même identifiant existe dans une autre source.
  }

  if (!sourceExisted) {
    throw new HttpError(500, "Aucune table d'utilisateurs reconnue dans cette base (PrismaSoft_Authentification_Utilisateur / PrismaGestionCo_personne / prismaCompta_utilisateur).");
  }
  throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
}
