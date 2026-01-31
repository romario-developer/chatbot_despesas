import { Router } from 'express';

import { authMiddleware } from './middleware/auth';
import { noCacheMiddleware } from './middleware/noCache';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import assistantRoutes from './routes/assistant';
import categoriesRoutes from './routes/categories';
import cardsRoutes from './routes/cards';
import creditsRoutes from './routes/credits';
import debugRoutes from './routes/debug';
import dashboardRoutes from './routes/dashboard';
import entriesRoutes from './routes/entries';
import meRoutes from './routes/me';
import planningRoutes from './routes/planning';
import quickEntryRoutes from './routes/quickEntry';
import reportsRoutes from './routes/reports';
import summaryRoutes from './routes/summary';
import aiRoutes from './routes/ai';
import requireDb from '../middlewares/requireDb';
import internalRoutes from './routes/internal';

export const API_BASE_PATH = '/api';
const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/internal', internalRoutes);

router.use(authMiddleware);
router.use(requireDb);

router.use('/assistant', assistantRoutes);
router.use('/ai', aiRoutes);
router.use(noCacheMiddleware);
router.use('/entries', entriesRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/cards', cardsRoutes);
router.use('/credits', creditsRoutes);
router.use('/credit', creditsRoutes);
router.use('/debug', debugRoutes);
router.use('/quick-entry', quickEntryRoutes);
router.use('/categories', categoriesRoutes);
router.use('/me', meRoutes);
router.use('/reports', reportsRoutes);
router.use('/summary', summaryRoutes);
router.use('/planning', planningRoutes);

router.use((req, res) => {
  console.warn(`[api] 404 ${req.method} ${req.originalUrl}`);
  return res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

export default router;
