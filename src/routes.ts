import { Router } from 'express';
import { connectionRouter } from './modules/connection/connection.routes.js';
import { authRouter } from './auth/auth.routes.js';
import { exercicesRouter } from './modules/exercices/exercices.routes.js';
import { journauxRouter } from './modules/journaux/journaux.routes.js';
import { planComptableRouter } from './modules/planComptable/planComptable.routes.js';
import { ecrituresRouter } from './modules/ecritures/ecritures.routes.js';
import { etatsRouter } from './modules/etats/etats.routes.js';
import { lettrageRouter } from './modules/lettrage/lettrage.routes.js';
import { piecesRouter } from './modules/pieces/pieces.routes.js';
import { clotureRouter } from './modules/cloture/cloture.routes.js';
import { rapprochementRouter } from './modules/rapprochement/rapprochement.routes.js';
import { fecRouter } from './modules/fec/fec.routes.js';
import { immosRouter } from './modules/immos/immos.routes.js';
import { liasseRouter } from './modules/liasse/liasse.routes.js';
import { clotureExerciceRouter } from './modules/clotureExercice/clotureExercice.routes.js';
import { analytiqueRouter } from './modules/analytique/analytique.routes.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => res.json({ ok: true }));

apiRouter.use('/connection', connectionRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/', exercicesRouter); // /societes, /exercices
apiRouter.use('/journaux', journauxRouter);
apiRouter.use('/comptes', planComptableRouter);
apiRouter.use('/ecritures', ecrituresRouter); // liste, /:id, /periodes, /save, /autorisation/check
apiRouter.use('/etats', etatsRouter); // /balance, /grand-livre/detail
apiRouter.use('/lettrage', lettrageRouter); // /comptes, /lignes, /lettrer, /delettrer, /auto
apiRouter.use('/pieces', piecesRouter); // pièces jointes GED
apiRouter.use('/cloture', clotureRouter); // clôture période/journal
apiRouter.use('/rapprochement', rapprochementRouter); // rapprochement bancaire par journal
apiRouter.use('/fec', fecRouter); // export FEC
apiRouter.use('/immos', immosRouter); // immobilisations
apiRouter.use('/liasse', liasseRouter); // bilan + compte de résultat
apiRouter.use('/cloture-exercice', clotureExerciceRouter); // clôture / déclôture d'exercice
apiRouter.use('/analytique', analytiqueRouter); // sections / natures analytiques
