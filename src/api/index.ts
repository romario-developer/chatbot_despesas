import { Router } from 'express';

import { authMiddleware } from './middleware/auth';
import { noCacheMiddleware } from './middleware/noCache';
import authRoutes from './routes/auth';
import categoriesRoutes from './routes/categories';
import entriesRoutes from './routes/entries';
import planningRoutes from './routes/planning';
import reportsRoutes from './routes/reports';
import summaryRoutes from './routes/summary';
import telegramRoutes from './routes/telegram';

export const API_BASE_PATH = '/api';
const router = Router();

router.get('/health', (_req, res) => {
  return res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/telegram', telegramRoutes);

router.use(authMiddleware);
router.use(noCacheMiddleware);
router.use('/entries', entriesRoutes);
router.use('/categories', categoriesRoutes);
router.use('/reports', reportsRoutes);
router.use('/summary', summaryRoutes);
router.use('/planning', planningRoutes);

router.use((req, res) => {
  console.warn(`[api] 404 ${req.method} ${req.originalUrl}`);
  return res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

export default router;
