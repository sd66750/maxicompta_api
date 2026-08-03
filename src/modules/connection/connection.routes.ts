import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { testConnectionString } from '../../db/pool.js';
import { getConnectionStatus, saveConnectionString } from '../../config/connectionStore.js';

export const connectionRouter = Router();

const bodySchema = z.object({
  connectionString: z.string().min(1, 'La chaîne de connexion est requise.'),
});

/** Déduit un libellé (InitialCatalog) sans exposer de secret. */
function extractLabel(raw: string): string {
  const m = raw.match(/initial\s+catalog\s*=\s*([^;]+)/i) ?? raw.match(/database\s*=\s*([^;]+)/i);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : 'base SQL Server';
}

/** GET /api/connection/status — indique si une connexion est configurée (sans secret). */
connectionRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await getConnectionStatus());
  })
);

/** POST /api/connection/test — teste une chaîne sans la persister. */
connectionRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { connectionString } = bodySchema.parse(req.body);
    try {
      const result = await testConnectionString(connectionString);
      res.json(result);
    } catch (err) {
      throw new HttpError(400, `Échec de connexion : ${err instanceof Error ? err.message : 'inconnue'}`);
    }
  })
);

/** POST /api/connection — teste puis chiffre et enregistre la chaîne. */
connectionRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { connectionString } = bodySchema.parse(req.body);
    try {
      await testConnectionString(connectionString);
    } catch (err) {
      throw new HttpError(400, `Échec de connexion : ${err instanceof Error ? err.message : 'inconnue'}`);
    }
    await saveConnectionString(connectionString, extractLabel(connectionString));
    res.json({ ok: true, ...(await getConnectionStatus()) });
  })
);
