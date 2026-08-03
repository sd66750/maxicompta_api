import bcrypt from 'bcryptjs';

/**
 * Le legacy stocke les mots de passe EN CLAIR dans prismaCompta_utilisateur.pass.
 * Pour rester compatible sans muter la base (l'app WinForms compare en clair),
 * on accepte les deux formats :
 *   - hash bcrypt (commence par $2a/$2b/$2y) → comparaison bcrypt
 *   - texte clair → comparaison directe
 *
 * La migration vers bcrypt pourra se faire ultérieurement via une colonne dédiée,
 * sans casser l'application d'origine.
 */
export async function verifyPassword(stored: string | null | undefined, provided: string): Promise<boolean> {
  if (stored == null) return false;
  if (/^\$2[aby]\$/.test(stored)) {
    return bcrypt.compare(provided, stored);
  }
  return stored === provided;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
