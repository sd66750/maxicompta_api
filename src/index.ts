import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './config/env.js';
import { apiRouter } from './routes.js';
import { errorHandler } from './http/helpers.js';

const app = express();

app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.use('/api', apiRouter);

// Prod : le serveur Node sert aussi le front (build Vite). Activé si CLIENT_DIST
// pointe sur un dossier existant ; en dev ce dossier n'existe pas → Vite gère.
const clientDist = env.clientDist ? path.resolve(env.clientDist) : '';
const serveFront = clientDist && fs.existsSync(path.join(clientDist, 'index.html'));
if (serveFront) {
  app.use(express.static(clientDist));
  // Fallback SPA : toute route hors /api renvoie index.html (React Router).
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] API PrismaSoft.Compta à l'écoute sur http://localhost:${env.port}`);
  console.log(`[server] CORS autorisé pour ${env.clientOrigin}`);
  console.log(serveFront ? `[server] Front servi depuis ${clientDist}` : `[server] Front non servi (mode dev / CLIENT_DIST vide)`);
});
