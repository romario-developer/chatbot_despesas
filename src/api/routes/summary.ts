import { Router } from 'express';

import { AuthedRequest } from '../middleware/auth';
import { getSummaryByUserIdAndMonth } from '../../services/summaryService';

const router = Router();

router.get('/', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Parametro "month" e obrigatorio no formato YYYY-MM' });
  }

  const userId = req.auth?.sub;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const summary = await getSummaryByUserIdAndMonth(numericUserId, month);
    return res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao calcular resumo.';
    if (message.includes('month')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo.' });
  }
});

export default router;
