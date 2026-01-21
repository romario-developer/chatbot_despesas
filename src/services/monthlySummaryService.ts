import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { dayjs, TZ } from "../utils/dates";
import { getPlanningByUserId } from "./planningService";
import { getMonthRangeFromIsoMonth } from "../utils/dateRange";
import { assertValidAmountCents, centsToNumber } from "../utils/money";

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
  receitas: number;
  gastosCaixa: number;
  gastosCredito: number;
  saldoEmConta: number;
};

export async function getMonthlySummary(params: { userId: number; month: string }) {
  const { userId, month } = params;

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Parametro "userId" e obrigatorio');
  }

  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Parametro "month" e obrigatorio no formato YYYY-MM');
  }

  const { start, endExclusive } = getMonthRangeFromIsoMonth(month, TZ);

  const isDebugDashboard = process.env.DEBUG_DASHBOARD === "1";

  const baseWhere = {
    userId,
    date: { gte: start, lt: endExclusive },
  } as const;

  const cashWhere = {
    ...baseWhere,
    paymentMethod: { not: "CREDIT" },
  } as const;

  const creditWhere = {
    ...baseWhere,
    paymentMethod: "CREDIT",
  } as const;

  const cardPaymentAggPromise = prisma.cardPayment
    .aggregate({
      where: {
        userId,
        paymentDate: { gte: start, lt: endExclusive },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    })
    .catch((err) => {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.message.includes("CardPayment")
      ) {
        if (isDebugDashboard) {
          console.warn("[dashboard-debug] CardPayment aggregation skipped", {
            userId,
            month,
            error: err.message,
          });
        }
        return {
          _sum: { amountCents: 0 },
          _count: { _all: 0 },
        };
      }
      throw err;
    });

  const [expenses, totalsAgg, totalsBySource, cashAgg, creditAgg, cardPaymentAgg] =
    await Promise.all([
      prisma.expense.findMany({
        where: baseWhere,
        include: { category: true },
      }),
      prisma.expense.aggregate({
        where: baseWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      prisma.expense.groupBy({
        where: baseWhere,
        by: ["source"],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      prisma.expense.aggregate({
        where: cashWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      prisma.expense.aggregate({
        where: creditWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      cardPaymentAggPromise,
    ]);

  const expensesCount = totalsAgg._count?._all ?? 0;
  const totalCents = totalsAgg._sum.amountCents ?? 0;
  const cashCount = cashAgg._count?._all ?? 0;
  const creditCount = creditAgg._count?._all ?? 0;
  const cardPaymentCount = cardPaymentAgg._count?._all ?? 0;
  const cardPaymentCents = cardPaymentAgg._sum.amountCents ?? 0;
  const totalPorCategoria = new Map<string, number>();
  const totalPorDia = new Map<string, number>();

  for (const expense of expenses) {
    const amountCents = assertValidAmountCents(expense.amountCents, `expense#${expense.id}.amountCents`, {
      allowZero: true,
    });

    const catKey = expense.category.name;
    totalPorCategoria.set(catKey, (totalPorCategoria.get(catKey) ?? 0) + amountCents);

    const dateKey = dayjs(expense.date).tz(TZ).format("YYYY-MM-DD");
    totalPorDia.set(dateKey, (totalPorDia.get(dateKey) ?? 0) + amountCents);
  }

  const planning = await getPlanningByUserId(userId);
  const salaryTotal = planning.salaryByMonth[month] ?? 0;
  const extrasTotal = (planning.extrasByMonth[month] ?? []).reduce((sum, item) => sum + item.amount, 0);
  const fixedPlannedTotal = planning.fixedBills.reduce((sum, item) => sum + item.amount, 0);
  const receita = salaryTotal + extrasTotal;
  const totalExpenses = centsToNumber(totalCents);
  const gastosCaixaCents = cashAgg._sum.amountCents ?? 0;
  const gastosCreditoCents = creditAgg._sum.amountCents ?? 0;
  const gastosCaixa = centsToNumber(gastosCaixaCents);
  const gastosCredito = centsToNumber(gastosCreditoCents);
  const cardPayments = centsToNumber(cardPaymentCents);
  const receitas = receita;
  const saldoEmConta = receitas - gastosCaixa - cardPayments;
  const balance = saldoEmConta;
  const forecastBalance = receitas - totalExpenses - fixedPlannedTotal;

  if (isDebugDashboard) {
    console.log("[dashboard-debug] month", { month, start: start.toISOString(), end: endExclusive.toISOString() });
    console.log("[dashboard-debug] counts", {
      expenses: expensesCount,
      cash: cashCount,
      credit: creditCount,
      cardPayments: cardPaymentCount,
    });
    console.log("[dashboard-debug] totals", {
      receitas,
      gastosCaixa,
      gastosCredito,
      cardPayments,
      saldoEmConta,
    });
  }

  console.log("[monthly-summary]", { userId, month });
  console.log("SUMMARY", {
    userId,
    month,
    totalExpenses,
    countBySource: totalsBySource.map((s) => ({ source: s.source, count: s._count._all, cents: s._sum.amountCents })),
  });

  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[summary] userId=%s month=%s start=%s end=%s count=%d totalCents=%d salary=%.2f extras=%.2f fixas=%.2f",
      userId,
      month,
      start.toISOString(),
      new Date(endExclusive.getTime() - 1).toISOString(),
      expensesCount,
      totalCents,
      salaryTotal,
      extrasTotal,
      fixedPlannedTotal,
    );
  }

  return {
    month,
    start: start,
    end: new Date(endExclusive.getTime() - 1),
    expensesCount,
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
    receitas,
    gastosCaixa,
    gastosCredito,
    saldoEmConta,
    balance,
    forecastBalance,
  };
}
