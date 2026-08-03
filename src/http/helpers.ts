import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ConnectionNotConfiguredError } from '../db/pool.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Enrobe un handler async pour propager les rejets vers le middleware d'erreur. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Middleware d'erreur global — renvoie un JSON homogène. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    console.warn('[validation] Données invalides :', JSON.stringify(err.flatten()));
    res.status(400).json({ error: 'Données invalides', details: err.flatten() });
    return;
  }
  if (err instanceof ConnectionNotConfiguredError) {
    res.status(409).json({ error: err.message, code: 'NO_CONNECTION' });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Erreur interne';
  console.error('[error]', err);
  res.status(500).json({ error: message });
}
