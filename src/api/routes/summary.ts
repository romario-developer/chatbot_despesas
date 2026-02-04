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

// GET /summary?month=YYYY-MM -> returns aggregates and planning values in centavos (salaryCents, extrasCents, receitasCents, gastosCents, balanceCents, etc.)
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
    console.log('[summary] request payload', { userId, month });
    const summary = await getMonthlySummary({
      userId,
      month,
    });

    const payload = {
      month: summary.month,

      // totais
      totalCents: summary.totalCents,
      total: summary.total,

      totalExpensesCents: summary.totalExpensesCents,
      totalExpenses: summary.totalExpenses,

      // planejamento
      salaryCents: summary.salaryCents,
      salary: summary.salaryTotal,

      extrasCents: summary.extrasCents,
      extras: summary.extrasTotal,

      // receitas e gastos
      receitasCents: summary.receitasCents,
      receitas: summary.receitas,

      gastosCaixaCents: summary.gastosCaixaCents,
      gastosCaixa: summary.gastosCaixa,

      gastosCreditoCents: summary.gastosCreditoCents,
      gastosCredito: summary.gastosCredito,

      // saldos
      saldoEmContaCents: summary.saldoEmContaCents,
      saldoEmConta: summary.saldoEmConta,

      balanceCents: summary.balanceCents,
      balance: summary.balance,

      saldoPrevistoCents: summary.forecastBalanceCents,
      saldoPrevisto: summary.forecastBalance,

      expensesCount: summary.expensesCount,

      totalPorCategoria: summary.totalPorCategoria.map((item) => ({
        category: item.category,
        totalCents: item.totalCents,
        total: item.total,
      })),

      totalPorDia: summary.totalPorDia.map((item) => ({
        date: item.date,
        totalCents: item.totalCents,
        total: item.total,
      })),
    };

    console.log('[summary] response (cents)', payload);
    return res.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao calcular resumo';
    if (message.toLowerCase().includes('month') || message.toLowerCase().includes('user')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao calcular resumo' });
  }
});

export default router;
