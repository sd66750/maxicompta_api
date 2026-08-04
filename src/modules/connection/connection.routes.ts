import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../http/helpers.js';
import { testConnectionString, listSocietes } from '../../db/pool.js';
import {
  getConnectionStatus,
  saveServerConnection,
  setActiveDatabase,
  getActiveDatabase,
  withDatabase,
} from '../../config/connectionStore.js';

export const connectionRouter = Router();

const bodySchema = z.object({
  connectionString: z.string().min(1, 'La chaîne de connexion est requise.'),
});

/** GET /api/connection/status — connexion configurée ? société active ? (sans secret) */
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

/** POST /api/connection — teste (sur master) puis chiffre/enregistre la connexion serveur. */
connectionRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { connectionString } = bodySchema.parse(req.body);
    try {
      // On valide l'accès au serveur via master (requis pour découvrir les sociétés).
      await testConnectionString(withDatabase(connectionString, 'master'));
    } catch (err) {
      throw new HttpError(400, `Échec de connexion : ${err instanceof Error ? err.message : 'inconnue'}`);
    }
    await saveServerConnection(connectionString);
    res.json({ ok: true, ...(await getConnectionStatus()) });
  })
);

/** GET /api/connection/databases — sociétés (bases PrismaSoft_%) + société active. */
connectionRouter.get(
  '/databases',
  asyncHandler(async (_req, res) => {
    try {
      const [databases, active] = await Promise.all([listSocietes(), getActiveDatabase()]);
      res.json({ databases, active });
    } catch (err) {
      throw new HttpError(400, `Impossible de lister les sociétés : ${err instanceof Error ? err.message : 'inconnue'}`);
    }
  })
);

/** POST /api/connection/database — définit la société active (validée contre la liste). */
connectionRouter.post(
  '/database',
  asyncHandler(async (req, res) => {
    const { database } = z.object({ database: z.string().min(1) }).parse(req.body);
    const list = await listSocietes();
    if (!list.includes(database)) {
      throw new HttpError(400, 'Société inconnue ou base non autorisée.');
    }
    await setActiveDatabase(database);
    res.json({ ok: true, active: database });
  })
);
