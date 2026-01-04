import { prisma } from "../db/prisma";
import { dayjs, TZ } from "../utils/dates";
import { API_TELEGRAM_ID } from "../utils/systemUsers";
import { getPlanningByUserId } from "./planningService";
import { getOrCreateUser } from "./userService";

type SummaryCategory = { category: string; totalCents: number; total: number };
type SummaryDay = { date: string; totalCents: number; total: number };

export type MonthlySummaryResult = {
  month: string;
  start: Date;
  end: Date;
  totalCents: number;
  total: number;
  totalPorCategoria: SummaryCategory[];
  totalPorDia: SummaryDay[];
  salaryTotal: number;
  extrasTotal: number;
  fixedPlannedTotal: number;
  balance: number;
  forecastBalance: number;
};

export async function getMonthlySummaryByAuthSub(params: { sub?: string; month: string }) {
  const telegramId = params.sub === "admin" ? API_TELEGRAM_ID : params.sub ?? API_TELEGRAM_ID;
  const user = await getOrCreateUser(telegramId);
  return getMonthlySummaryByUserId({ userId: user.id, month: params.month });
}

// Compat wrapper for existing routes (expects numeric userId)
export async function getMonthlySummaryByUserAndMonth(userId: number, month: string) {
  return getMonthlySummaryByUserId({ userId, month });
}

export async function getMonthlySummaryByUserId(params: { userId: number; month: string }) {
  const { userId, month } = params;

  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Parametro "month" é obrigatório no formato YYYY-MM');
  }

  const parsed = dayjs.tz(`${month}-01`, "YYYY-MM-DD", TZ);
  if (!parsed.isValid()) {
    throw new Error('Parâmetro "month" inválido');
  }

  const start = parsed.startOf("month");
  const end = start.endOf("month");

  const expenses = await prisma.expense.findMany({
    where: {
      userId,
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

  const planning = await getPlanningByUserId(userId);
  const salaryTotal = planning.salaryByMonth[month] ?? 0;
  const extrasTotal = (planning.extrasByMonth[month] ?? []).reduce((sum, item) => sum + item.amount, 0);
  const fixedPlannedTotal = planning.fixedBills.reduce((sum, item) => sum + item.amount, 0);
  const receita = salaryTotal + extrasTotal;
  const balance = receita - totalCents / 100;
  const forecastBalance = receita - totalCents / 100 - fixedPlannedTotal;

  return {
    month,
    start: start.toDate(),
    end: end.toDate(),
    totalCents,
    total: centsToNumber(totalCents),
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
