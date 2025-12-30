import { prisma } from '../db/prisma';
import { getMonthRange } from '../utils/dates';
import { getOrCreateUser } from './userService';

export async function getMonthlyReport(telegramId: string, month: number, year: number) {
  const user = await getOrCreateUser(telegramId);
  const { start, end } = getMonthRange(month, year);

  const expenses = await prisma.expense.findMany({
    where: {
      userId: user.id,
      date: {
        gte: start,
        lte: end,
      },
    },
    include: { category: true },
    orderBy: { date: 'desc' },
  });

  const totalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);

  const categoryMap = new Map<
    number,
    { name: string; totalCents: number; count: number }
  >();

  expenses.forEach((exp) => {
    const current = categoryMap.get(exp.categoryId) ?? {
      name: exp.category.name,
      totalCents: 0,
      count: 0,
    };

    current.totalCents += exp.amountCents;
    current.count += 1;
    categoryMap.set(exp.categoryId, current);
  });

  const categorySummary = Array.from(categoryMap.values()).sort(
    (a, b) => b.totalCents - a.totalCents,
  );

  const topExpenses = expenses.slice(0, 10);

  return {
    user,
    totalCents,
    categorySummary,
    topExpenses,
    start,
    end,
    expensesCount: expenses.length,
  };
}

export async function getMonthlyExpensesPage(
  telegramId: string,
  month: number,
  year: number,
  page: number,
  pageSize: number,
) {
  const user = await getOrCreateUser(telegramId);
  const { start, end } = getMonthRange(month, year);

  const where = {
    userId: user.id,
    date: {
      gte: start,
      lte: end,
    },
  } as const;

  const totalCount = await prisma.expense.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const skip = (currentPage - 1) * pageSize;

  const [items, totalAgg] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { category: true },
      orderBy: { date: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.expense.aggregate({
      where,
      _sum: { amountCents: true },
    }),
  ]);

  const totalCents = totalAgg._sum.amountCents ?? 0;

  return {
    user,
    items,
    totalCount,
    totalPages,
    page: currentPage,
    pageSize,
    totalCents,
  };
}
