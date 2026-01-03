import { prisma } from '../db/prisma';
import { dayjs, TZ } from '../utils/dates';

function centsToNumber(cents: number) {
  return Number((cents / 100).toFixed(2));
}

export async function getSummaryByUserIdAndMonth(userId: number, month: string) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Parâmetro "month" é obrigatório no formato YYYY-MM');
  }

  const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
  if (!parsed.isValid()) {
    throw new Error('Parâmetro "month" inválido');
  }

  const start = parsed.startOf('month');
  const end = start.endOf('month');

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      source: { not: 'manual' },
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

  return {
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
  };
}
