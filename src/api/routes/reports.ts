import { Router } from 'express';

import { getMonthlySummary } from '../../services/monthlySummaryService';
import { AuthedRequest } from '../middleware/auth';
import { resolveAuthUserId } from '../utils/authUser';

const router = Router();

function parseMonthParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

router.get('/monthly-summary', async (req: AuthedRequest, res) => {
  const month = parseMonthParam(req.query.month);
  const userTelegramId = resolveAuthUserId(req);

  if (!month) {
    return res.status(400).json({ error: 'Parametro "month" e obrigatorio no formato YYYY-MM' });
  }

  try {
    const summary = await getMonthlySummary({
      userId: userTelegramId,
      month,
    });
    return res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao calcular resumo.';
    if (message.toLowerCase().includes('month') || message.toLowerCase().includes('user')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo.' });
  }
});

export default router;
