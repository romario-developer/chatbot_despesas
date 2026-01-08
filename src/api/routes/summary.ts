import { Router } from 'express';

import { getMonthlySummary } from '../../services/monthlySummaryService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

function parseMonthParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

router.get('/', async (req: AuthedRequest, res) => {
  const month = parseMonthParam(req.query.month);
  const userId = req.user?.id;

  if (!month) {
    return res.status(400).json({ error: 'Parametro "month" e obrigatorio no formato YYYY-MM' });
  }
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const summary = await getMonthlySummary({
      userId,
      month,
    });

    return res.json({
      month: summary.month,
      total: summary.total,
      totalExpenses: summary.totalExpenses,
      expensesCount: summary.expensesCount,
      totalPorCategoria: summary.totalPorCategoria.map((item) => ({
        category: item.category,
        total: item.total,
      })),
      totalPorDia: summary.totalPorDia.map((item) => ({
        date: item.date,
        total: item.total,
      })),
      salary: summary.salaryTotal,
      extras: summary.extrasTotal,
      fixas: summary.fixedPlannedTotal,
      saldo: summary.balance,
      saldoPrevisto: summary.forecastBalance,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao calcular resumo';
    if (message.toLowerCase().includes('month') || message.toLowerCase().includes('user')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo' });
  }
});

export default router;
