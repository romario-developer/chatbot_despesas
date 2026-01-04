import { Router } from 'express';

import { AuthedRequest } from '../middleware/auth';
import { getMonthlySummaryByAuthSub } from '../../services/monthlySummaryService';

const router = Router();

router.get('/', async (req: AuthedRequest, res) => {
  const { month } = req.query;

  try {
    const summary = await getMonthlySummaryByAuthSub({
      sub: req.auth?.sub,
      month: typeof month === 'string' ? month : '',
    });

    return res.json({
      month: summary.month,
      total: summary.total,
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
    if (message.toLowerCase().includes('month')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo' });
  }
});

export default router;
