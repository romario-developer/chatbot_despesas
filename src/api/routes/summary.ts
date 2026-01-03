import { Router } from 'express';

import { AuthedRequest } from '../middleware/auth';
import { getOrCreateUser } from '../../services/userService';
import { getSummaryByUserIdAndMonth } from '../../services/summaryService';

const router = Router();
const API_TELEGRAM_ID = 'api-admin';

router.get('/', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Parâmetro "month" é obrigatório no formato YYYY-MM' });
  }

  const sub = req.auth?.sub ?? 'admin';
  const telegramId = sub === 'admin' ? API_TELEGRAM_ID : sub;
  const user = await getOrCreateUser(telegramId);

  try {
    const summary = await getSummaryByUserIdAndMonth(user.id, month);
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
