import { prisma } from "../db/prisma";
import { dayjs, TZ } from "../utils/dates";
import { getPlanningByUserId } from "./planningService";
import { getOrCreateUser } from "./userService";

type SummaryCategory = { category: string; totalCents: number; total: number };
type SummaryDay = { date: string; totalCents: number; total: number };

export type MonthlySummaryResult = {
  month: string;
  start: Date;
  end: Date;
  expensesCount: number;
  totalCents: number;
  total: number;
  totalExpenses: number;
  totalPorCategoria: SummaryCategory[];
  totalPorDia: SummaryDay[];
  salaryTotal: number;
  extrasTotal: number;
  fixedPlannedTotal: number;
  balance: number;
  forecastBalance: number;
};

export async function getMonthlySummary(params: { userId: string; month: string }) {
  const { userId, month } = params;

  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error('Parametro "userId" e obrigatorio');
  }

  const trimmedUserId = userId.trim();

  let user = null as Awaited<ReturnType<typeof getOrCreateUser>> | null;
  if (/^\d+$/.test(trimmedUserId)) {
    const existing = await prisma.user.findUnique({ where: { id: Number(trimmedUserId) } });
    if (existing) {
      user = existing;
    }
  }

  if (!user) {
    user = await getOrCreateUser(trimmedUserId);
  }

  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Parametro "month" e obrigatorio no formato YYYY-MM');
  }

  const parsed = dayjs.tz(`${month}-01`, "YYYY-MM-DD", TZ);
  if (!parsed.isValid()) {
    throw new Error('Parametro "month" invalido');
  }

  const start = parsed.startOf("month");
  const end = start.endOf("month");

  const expenses = await prisma.expense.findMany({
    where: {
      userId: user.id,
      source: { not: "manual" },
      date: { gte: start.toDate(), lte: end.toDate() },
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

    const dateKey = dayjs(expense.date).tz(TZ).format("YYYY-MM-DD");
    totalPorDia.set(dateKey, (totalPorDia.get(dateKey) ?? 0) + expense.amountCents);
  }

  const planning = await getPlanningByUserId(user.id);
  const salaryTotal = planning.salaryByMonth[month] ?? 0;
  const extrasTotal = (planning.extrasByMonth[month] ?? []).reduce((sum, item) => sum + item.amount, 0);
  const fixedPlannedTotal = planning.fixedBills.reduce((sum, item) => sum + item.amount, 0);
  const receita = salaryTotal + extrasTotal;
  const totalExpenses = centsToNumber(totalCents);
  const balance = receita - totalExpenses;
  const forecastBalance = receita - totalExpenses - fixedPlannedTotal;

  console.log("[monthly-summary]", { userId: user.id, month });
  console.log("SUMMARY", { userId: user.id, month, totalExpenses });

  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[summary] userId=%s month=%s start=%s end=%s count=%d totalCents=%d salary=%.2f extras=%.2f fixas=%.2f",
      user.id,
      month,
      start.toISOString(),
      end.toISOString(),
      expenses.length,
      totalCents,
      salaryTotal,
      extrasTotal,
      fixedPlannedTotal,
    );
  }

  return {
    month,
    start: start.toDate(),
    end: end.toDate(),
    expensesCount: expenses.length,
    totalCents,
    total: centsToNumber(totalCents),
    totalExpenses,
    totalPorCategoria: Array.from(totalPorCategoria.entries()).map(([category, cents]) => ({
      category,
      totalCents: cents,
      total: centsToNumber(cents),
    })),
    totalPorDia: Array.from(totalPorDia.entries()).map(([date, cents]) => ({
      date,
      totalCents: cents,
      total: centsToNumber(cents),
    })),
    salaryTotal,
    extrasTotal,
    fixedPlannedTotal,
    balance,
    forecastBalance,
  };
}

function centsToNumber(cents: number) {
  return Number((cents / 100).toFixed(2));
}
