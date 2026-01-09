import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { getMonthlySummary } from '../../services/monthlySummaryService';
import { dayjs, nowBahia, TZ } from '../../utils/dates';
import { getMonthRangeFromMonthYear } from '../../utils/dateRange';
import { assertValidAmountCents, centsToNumber } from '../../utils/money';
import { getCategoryColor } from '../../utils/colors';
import type { AuthedRequest } from '../middleware/auth';

const router = Router();

function parseMonthParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

router.get('/summary', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const providedMonth = typeof req.query.month !== 'undefined';
  const parsedMonth = parseMonthParam(req.query.month);
  if (providedMonth && !parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }
  const month = parsedMonth ?? nowBahia().format('YYYY-MM');

  try {
    const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
    if (!parsed.isValid()) {
      return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
    }

    const { start, endExclusive } = getMonthRangeFromMonthYear(parsed.month() + 1, parsed.year(), TZ);

    const [summary, totals] = await Promise.all([
      getMonthlySummary({ userId, month }),
      prisma.expense.groupBy({
        where: {
          userId,
          date: { gte: start, lt: endExclusive },
        },
        by: ['categoryId'],
        _sum: { amountCents: true },
      }),
    ]);

    const categoryIds = totals.map((item) => item.categoryId);
    const categories = categoryIds.length
      ? await prisma.category.findMany({ where: { userId, id: { in: categoryIds } } })
      : [];
    const categoryMap = new Map(categories.map((cat) => [cat.id, cat]));

    const byCategory = totals
      .map((item) => {
        const category = categoryMap.get(item.categoryId);
        if (!category) return null;
        const amountCents = assertValidAmountCents(item._sum.amountCents ?? 0, 'category.amountCents', {
          allowZero: true,
        });
        return {
          categoryId: category.id,
          categoryName: category.name,
          color: getCategoryColor(category.name),
          total: centsToNumber(amountCents),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.total - a.total);

    const incomeTotal = summary.salaryTotal + summary.extrasTotal;
    const expenseTotal = summary.totalExpenses;
    const balance = summary.balance;

    return res.json({
      month,
      balance,
      incomeTotal,
      expenseTotal,
      byCategory,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao carregar resumo';
    if (message.toLowerCase().includes('month') || message.toLowerCase().includes('user')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'Erro ao carregar resumo' });
  }
});

export default router;
