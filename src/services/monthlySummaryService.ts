import { prisma } from '../db/prisma';
import { dayjs, TZ } from '../utils/dates';
import { getPlanningByUserId } from './planningService';

type MonthlySummaryCategory = {
  categoryId: number;
  categoryName: string;
  totalExpenses: number;
  totalIncomes: number;
};

type MonthlySummaryTransaction = {
  id: number;
  date: string;
  description: string;
  categoryId: number;
  categoryName: string;
  amount: number;
  type: 'expense' | 'income';
};

export type MonthlySummary = {
  month: string;
  incomeTotal: number;
  expenseTotal: number;
  fixedPlannedTotal: number;
  balance: number;
  plannedBalance: number;
  byCategory: MonthlySummaryCategory[];
  lastTransactions: MonthlySummaryTransaction[];
};

function centsToAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function amountToCents(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

function parseMonth(month: string) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Parametro "month" e obrigatorio no formato YYYY-MM');
  }

  const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
  if (!parsed.isValid()) {
    throw new Error('Parametro "month" invalido');
  }

  const start = parsed.startOf('month');
  const end = start.endOf('month');
  return { start: start.toDate(), end: end.toDate() };
}

function debugMonthlySummary(params: { userId: number; month: string; count: number }) {
  if (process.env.NODE_ENV === 'production') return;
  // eslint-disable-next-line no-console
  console.debug(`[monthly-summary] userId=${params.userId} month=${params.month} count=${params.count}`);
}

export async function getMonthlySummaryByUserAndMonth(
  userId: number,
  month: string,
): Promise<MonthlySummary> {
  const { start, end } = parseMonth(month);

  const [planning, expenses] = await Promise.all([
    getPlanningByUserId(userId),
    prisma.expense.findMany({
      where: {
        userId,
        date: {
          gte: start,
          lte: end,
        },
      },
      include: { category: true },
      orderBy: { date: 'desc' },
    }),
  ]);

  const expenseTotalCents = expenses.reduce((sum, exp) => sum + exp.amountCents, 0);

  const salaryCents = amountToCents(planning.salaryByMonth[month] ?? 0);
  const extrasCents = (planning.extrasByMonth[month] ?? []).reduce(
    (sum, item) => sum + amountToCents(item.amount),
    0,
  );
  const incomeTotalCents = salaryCents + extrasCents;

  const fixedPlannedTotalCents = planning.fixedBills.reduce(
    (sum, bill) => sum + amountToCents(bill.amount),
    0,
  );

  const categoryMap = new Map<
    number,
    MonthlySummaryCategory & { totalExpensesCents: number; totalIncomesCents: number }
  >();
  expenses.forEach((exp) => {
    const current = categoryMap.get(exp.categoryId) ?? {
      categoryId: exp.categoryId,
      categoryName: exp.category.name,
      totalExpenses: 0,
      totalExpensesCents: 0,
      totalIncomes: 0,
      totalIncomesCents: 0,
    };
    current.totalExpensesCents += exp.amountCents;
    categoryMap.set(exp.categoryId, current);
  });

  const balanceCents = incomeTotalCents - expenseTotalCents;
  const plannedBalanceCents = incomeTotalCents - expenseTotalCents - fixedPlannedTotalCents;

  const lastTransactions: MonthlySummaryTransaction[] = expenses.slice(0, 10).map((exp) => ({
    id: exp.id,
    date: dayjs(exp.date).tz(TZ).format('YYYY-MM-DD'),
    description: exp.description,
    categoryId: exp.categoryId,
    categoryName: exp.category.name,
    amount: centsToAmount(exp.amountCents),
    type: 'expense',
  }));

  debugMonthlySummary({ userId, month, count: expenses.length });

  return {
    month,
    incomeTotal: centsToAmount(incomeTotalCents),
    expenseTotal: centsToAmount(expenseTotalCents),
    fixedPlannedTotal: centsToAmount(fixedPlannedTotalCents),
    balance: centsToAmount(balanceCents),
    plannedBalance: centsToAmount(plannedBalanceCents),
    byCategory: Array.from(categoryMap.values())
      .map((item) => ({
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        totalExpenses: centsToAmount(item.totalExpensesCents),
        totalIncomes: centsToAmount(item.totalIncomesCents),
      }))
      .sort((a, b) => b.totalExpenses - a.totalExpenses),
    lastTransactions,
  };
}
