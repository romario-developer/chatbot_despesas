import { prisma } from '../db/prisma';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { getOrCreateUser } from './userService';

async function buildMonthlyReport(userId: number, month: number, year: number) {
  const { start, endExclusive } = getMonthRangeFromMonthYear(month, year);

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
      date: {
        gte: start,
        lt: endExclusive,
      },
    },
    include: { category: true },
    orderBy: { date: 'desc' },
  });

  const totalCents = expenses.reduce(
    (sum: number, e: typeof expenses[number]) => sum + e.amountCents,
    0,
  );

  const categoryMap = new Map<
    number,
    { name: string; totalCents: number; count: number }
  >();

  expenses.forEach((exp: typeof expenses[number]) => {
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
    userId,
    totalCents,
    categorySummary,
    topExpenses,
    start,
    end: new Date(endExclusive.getTime() - 1),
    expensesCount: expenses.length,
  };
}

export async function getMonthlyReport(telegramId: string, month: number, year: number) {
  const user = await getOrCreateUser(telegramId);
  const data = await buildMonthlyReport(user.id, month, year);
  return { ...data, user };
}

export async function getMonthlyReportByUserId(userId: number, month: number, year: number) {
  return buildMonthlyReport(userId, month, year);
}

export async function getMonthlyExpensesPage(
  telegramId: string,
  month: number,
  year: number,
  page: number,
  pageSize: number,
) {
  const user = await getOrCreateUser(telegramId);
  const { start, endExclusive } = getMonthRangeFromMonthYear(month, year);

  const where = {
    userId: user.id,
    date: {
      gte: start,
      lt: endExclusive,
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
