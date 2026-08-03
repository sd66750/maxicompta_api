/**
 * Génération du code de lettrage (séquence alphabétique AAA → AAB → … → ZZZ →
 * AAAA), par compte. Le corps de la procédure legacy
 * PrismaSoft_Reglement_LettrageSuivant n'est pas fourni dans le dépôt ; on
 * reproduit une séquence de lettres, portée par compte, plafonnée à varchar(5).
 */

/** Successeur alphabétique d'un code (A-Z), avec débordement (ajout d'une lettre). */
export function incrementCode(code: string): string {
  const chars = code.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === 'Z') {
      chars[i] = 'A';
      i--;
    } else {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  return 'A' + chars.join(''); // débordement : ZZZ -> AAAA
}

/** Prochain code non utilisé, à partir des codes existants du compte. Démarre à AAA. */
export function nextLettrageCode(existing: string[]): string {
  const valid = existing
    .map((c) => (c ?? '').trim().toUpperCase())
    .filter((c) => /^[A-Z]+$/.test(c));
  if (valid.length === 0) return 'AAA';
  // max = le plus long, puis le plus grand lexicographiquement
  valid.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const max = valid[valid.length - 1];
  const next = incrementCode(max);
  return next.length > 5 ? next.slice(-5) : next; // colonne varchar(5)
}
