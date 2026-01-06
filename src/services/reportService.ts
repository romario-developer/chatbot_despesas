import { prisma } from '../db/prisma';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { getOrCreateUser } from './userService';
import { assertValidAmountCents } from '../utils/money';

async function buildMonthlyReport(userId: number, month: number, year: number) {
  const { start, endExclusive } = getMonthRangeFromMonthYear(month, year);

  const where = {
    userId,
    date: {
      gte: start,
      lt: endExclusive,
    },
  } as const;

  const [expenses, totalsAgg, categoryAgg] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { category: true },
      orderBy: { date: 'desc' },
    }),
    prisma.expense.aggregate({
      where,
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.expense.groupBy({
      where,
      by: ['categoryId'],
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
  ]);

  const normalizedExpenses = expenses.map((exp) => ({
    ...exp,
    amountCents: assertValidAmountCents(exp.amountCents, `expense#${exp.id}.amountCents`, {
      allowZero: true,
    }),
  }));

  const categoryNames = new Map<number, string>();
  normalizedExpenses.forEach((exp) => {
    if (!categoryNames.has(exp.categoryId)) {
      categoryNames.set(exp.categoryId, exp.category.name);
    }
  });

  const categorySummary = categoryAgg
    .map((row) => ({
      name: categoryNames.get(row.categoryId) ?? `Categoria ${row.categoryId}`,
      totalCents: row._sum.amountCents ?? 0,
      count: row._count._all ?? 0,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const totalCents = totalsAgg._sum.amountCents ?? 0;
  const expensesCount = totalsAgg._count?._all ?? 0;
  const topExpenses = normalizedExpenses.slice(0, 10);

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
  items.forEach((item) =>
    assertValidAmountCents(item.amountCents, `expense#${item.id}.amountCents`, { allowZero: true }),
  );

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
