import { Router } from 'express';

import { getMonthlySummaryByUserAndMonth } from '../../services/monthlySummaryService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

router.get('/monthly-summary', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  if (typeof month !== 'string') {
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
    const summary = await getMonthlySummaryByUserAndMonth(numericUserId, month);
    return res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao calcular resumo.';
    if (message.toLowerCase().includes('month')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo.' });
  }
});

export default router;
