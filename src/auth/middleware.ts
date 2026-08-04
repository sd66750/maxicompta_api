import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type SessionUser } from './jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/**
 * Exige un JWT valide. Transporté par l'en-tête dédié `X-Auth-Token` (pour ne pas
 * entrer en conflit avec le `Authorization: Basic` du reverse-proxy) ; on accepte
 * aussi `Authorization: Bearer <token>` en repli.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const custom = req.headers['x-auth-token'];
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : undefined;
  const token = (typeof custom === 'string' && custom) || bearer;
  if (!token) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée ou invalide.' });
  }
}
