import { Router } from 'express';

import { authMiddleware } from './middleware/auth';
import { noCacheMiddleware } from './middleware/noCache';
import authRoutes from './routes/auth';
import categoriesRoutes from './routes/categories';
import entriesRoutes from './routes/entries';
import planningRoutes from './routes/planning';
import summaryRoutes from './routes/summary';

const router = Router();

router.use('/auth', authRoutes);

router.use(authMiddleware);
router.use(noCacheMiddleware);
router.use('/entries', entriesRoutes);
router.use('/categories', categoriesRoutes);
router.use('/summary', summaryRoutes);
router.use('/planning', planningRoutes);

export default router;
