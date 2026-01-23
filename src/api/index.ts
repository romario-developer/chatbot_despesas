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

export const API_BASE_PATH = '/api';
const router = Router();

router.get('/health', (_req, res) => {
  return res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);

router.use(authMiddleware);
router.use('/assistant', assistantRoutes);
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
