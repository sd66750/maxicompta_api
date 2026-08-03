import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface SessionUser {
  userId: number;
  login: string;
  nom?: string;
  prenom?: string;
}

export function signToken(user: SessionUser): string {
  return jwt.sign(user, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(token: string): SessionUser {
  const payload = jwt.verify(token, env.jwtSecret);
  if (typeof payload === 'string') throw new Error('Token invalide');
  return {
    userId: Number(payload.userId),
    login: String(payload.login),
    nom: payload.nom as string | undefined,
    prenom: payload.prenom as string | undefined,
  };
}
