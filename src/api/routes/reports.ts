import { Router } from 'express';

import { getMonthlySummaryByUserAndMonth } from '../../services/monthlySummaryService';
import { getOrCreateUser } from '../../services/userService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();
const API_TELEGRAM_ID = 'api-admin';

router.get('/monthly-summary', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  if (typeof month !== 'string') {
    return res.status(400).json({ error: 'Parametro "month" e obrigatorio no formato YYYY-MM' });
  }

  const sub = req.auth?.sub ?? 'admin';
  const telegramId = sub === 'admin' ? API_TELEGRAM_ID : sub;
  const user = await getOrCreateUser(telegramId);

  try {
    const summary = await getMonthlySummaryByUserAndMonth(user.id, month);
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
