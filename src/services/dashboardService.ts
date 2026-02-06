import { prisma } from '../infra/db/prisma';
import { getPlanningByUserId } from './planningService';
import { dayjs, nowBahia, TZ } from '../utils/dates';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { assertValidAmountCents } from '../utils/money';
import { getCategoryColor } from '../utils/colors';
import { ApiError } from '../errors/ApiError';

export interface CategorySummary {
  categoryId: number;
  categoryName: string;
  color: string;
  total: number;
  totalCents: number;
}

export interface DashboardSummary {
  month: string;
  balance: number;
  incomeTotal: number;
  expenseTotal: number;
  byCategory: CategorySummary[];
}

export async function getDashboardSummary(userId: number, month?: string): Promise<DashboardSummary> {
  const monthToUse = month || nowBahia().format('YYYY-MM');
  const parsed = dayjs.tz(`${monthToUse}-01`, 'YYYY-MM-DD', TZ);
  if (!parsed.isValid()) {
    throw new ApiError('Parametro "month" invalido. Use YYYY-MM.', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const { start, endExclusive } = getMonthRangeFromMonthYear(parsed.month() + 1, parsed.year(), TZ);

  const [planning, totals] = await Promise.all([
    getPlanningByUserId(userId),
    prisma.expense.groupBy({
      where: {
        userId,
        date: { gte: start, lt: endExclusive },
        paymentMethod: { not: 'CREDIT' },
      },
      by: ['categoryId'],
      _sum: { amountCents: true },
    }),
  ]);

  const categoryTotals = new Map<number, number>();
  let expenseTotalCents = 0;
  for (const item of totals) {
    const amountCents = assertValidAmountCents(item._sum.amountCents ?? 0, 'category.amountCents', {
      allowZero: true,
    });
    categoryTotals.set(item.categoryId, amountCents);
    expenseTotalCents += amountCents;
  }

  const categoryIds = Array.from(categoryTotals.keys());
  const categories = categoryIds.length
    ? await prisma.category.findMany({ where: { userId, id: { in: categoryIds } } })
    : [];
  const categoryMap = new Map(categories.map((cat) => [cat.id, cat]));

  const byCategory = Array.from(categoryTotals.entries())
    .map(([categoryId, amountCents]) => {
      const category = categoryMap.get(categoryId);
      if (!category) return null;
      return {
        categoryId,
        categoryName: category.name,
        color: getCategoryColor(category.name),
        total: amountCents,
        totalCents: amountCents,
      };
    })
    .filter((item): item is CategorySummary => Boolean(item))
    .sort((a, b) => b.total - a.total);

  const salaryCents = planning.salaryByMonth[monthToUse] ?? 0;
  const extrasCents = (planning.extrasByMonth[monthToUse] ?? []).reduce((sum, item) => sum + item.amount, 0);
  const incomeTotalCents = salaryCents + extrasCents;
  const balanceCents = incomeTotalCents - expenseTotalCents;

  return {
    month: monthToUse,
    balance: balanceCents,
    incomeTotal: incomeTotalCents,
    expenseTotal: expenseTotalCents,
    byCategory,
  };
}
