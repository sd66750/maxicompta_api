import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/helpers.js';
import { login } from './auth.service.js';
import { requireAuth } from './middleware.js';

export const authRouter = Router();

const loginSchema = z.object({
  identifiant: z.string().min(1),
  motDePasse: z.string().min(1),
});

/** POST /api/auth/login */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { identifiant, motDePasse } = loginSchema.parse(req.body);
    const result = await login(identifiant, motDePasse);
    res.json(result);
  })
);

/** GET /api/auth/me — renvoie l'utilisateur du token courant. */
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
