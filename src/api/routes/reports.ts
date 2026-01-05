import { Router } from 'express';

import { getMonthlySummaryByAuthSub } from '../../services/monthlySummaryService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

router.get('/monthly-summary', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  try {
    const summary = await getMonthlySummaryByAuthSub({
      sub: req.auth?.sub,
      month: typeof month === 'string' ? month : '',
    });
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
