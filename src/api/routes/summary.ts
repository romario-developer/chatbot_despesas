import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { dayjs, TZ } from '../../utils/dates';

const router = Router();

function centsToNumber(cents: number) {
  return Number((cents / 100).toFixed(2));
}

router.get('/', async (req, res) => {
  const { month } = req.query;

  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Parâmetro "month" é obrigatório no formato YYYY-MM' });
  }

  const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
  if (!parsed.isValid()) {
    return res.status(400).json({ error: 'Parâmetro "month" inválido' });
  }

  const start = parsed.startOf('month');
  const end = start.endOf('month');

  const expenses = await prisma.expense.findMany({
    where: {
      date: {
        gte: start.toDate(),
        lte: end.toDate(),
      },
    },
    include: { category: true },
  });

  let totalCents = 0;
  const totalPorCategoria = new Map<string, number>();
  const totalPorDia = new Map<string, number>();

  for (const expense of expenses) {
    totalCents += expense.amountCents;

    const catKey = expense.category.name;
    totalPorCategoria.set(catKey, (totalPorCategoria.get(catKey) ?? 0) + expense.amountCents);

    const dateKey = dayjs(expense.date).tz(TZ).format('YYYY-MM-DD');
    totalPorDia.set(dateKey, (totalPorDia.get(dateKey) ?? 0) + expense.amountCents);
  }

  return res.json({
    month,
    total: centsToNumber(totalCents),
    totalPorCategoria: Array.from(totalPorCategoria.entries()).map(([category, cents]) => ({
      category,
      total: centsToNumber(cents),
    })),
    totalPorDia: Array.from(totalPorDia.entries()).map(([date, cents]) => ({
      date,
      total: centsToNumber(cents),
    })),
  });
});

export default router;
