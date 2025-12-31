import { Router } from 'express';

import { authMiddleware } from './middleware/auth';
import authRoutes from './routes/auth';
import categoriesRoutes from './routes/categories';
import entriesRoutes from './routes/entries';
import summaryRoutes from './routes/summary';

const router = Router();

router.use('/auth', authRoutes);

router.use(authMiddleware);
router.use('/entries', entriesRoutes);
router.use('/categories', categoriesRoutes);
router.use('/summary', summaryRoutes);

export default router;
