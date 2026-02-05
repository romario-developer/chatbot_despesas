import { Prisma } from "@prisma/client";
import { prisma } from "../infra/db/prisma";
import { dayjs, TZ } from "../utils/dates";
import { getPlanningByUserId } from "./planningService";
import { getMonthRangeFromIsoMonth } from "../utils/dateRange";
import { assertValidAmountCents } from "../utils/money";

type SummaryCategory = { category: string; totalCents: number; total: number };
type SummaryDay = { date: string; totalCents: number; total: number };

export type MonthlySummaryResult = {
  month: string;
  start: Date;
  end: Date;
  expensesCount: number;
  totalCents: number;
  totalExpensesCents: number;
  totalPorCategoria: SummaryCategory[];
  totalPorDia: SummaryDay[];
  salaryCents: number;
  extrasCents: number;
  fixedPlannedTotalCents: number;
  balanceCents: number;
  forecastBalanceCents: number;
  receitasCents: number;
  gastosCaixaCents: number;
  gastosCreditoCents: number;
  cardPaymentsCents: number;
  saldoEmContaCents: number;
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

  // planning deve estar em CENTAVOS
  const salaryCents = assertValidAmountCents(
    planning.salaryByMonth[month] ?? 0,
    `planning.salaryByMonth[${month}]`,
    { allowZero: true }
  );

  const extrasCents = (planning.extrasByMonth[month] ?? []).reduce((sum, item) => {
    // item.amount deve ser CENTAVOS
    const c = assertValidAmountCents(item.amount, `planning.extra.amount`, { allowZero: true });
    return sum + c;
  }, 0);

  const fixedPlannedTotalCents = planning.fixedBills.reduce((sum, item) => {
    const c = assertValidAmountCents(item.amount, `planning.fixedBill.amount`, { allowZero: true });
    return sum + c;
  }, 0);

  const totalExpensesCents = totalCents;
  const receitasCents = salaryCents + extrasCents;
  const gastosCaixaCents = cashAgg._sum.amountCents ?? 0;
  const gastosCreditoCents = creditAgg._sum.amountCents ?? 0;
  const cardPaymentsCents = cardPaymentCents;

  const saldoEmContaCents = receitasCents - gastosCaixaCents - cardPaymentsCents;
  const balanceCents = saldoEmContaCents;
  const forecastBalanceCents = receitasCents - totalExpensesCents - fixedPlannedTotalCents;

  if (isDebugDashboard) {
    console.log("[dashboard-debug] totals (CENTS)", {
      salaryCents,
      extrasCents,
      receitasCents,
      gastosCaixaCents,
      gastosCreditoCents,
      cardPaymentsCents,
      saldoEmContaCents,
      balanceCents,
      forecastBalanceCents,
      totalExpensesCents,
      fixedPlannedTotalCents,
    });
  }

  console.log("[monthly-summary-values]", {
    month,
    totalCents,
    totalExpensesCents,
    receitasCents,
    gastosCaixaCents,
    gastosCreditoCents,
    saldoEmContaCents,
    balanceCents,
    forecastBalanceCents,
    fixedPlannedTotalCents,
  });

  return {
    month,
    start,
    end: new Date(endExclusive.getTime() - 1),

    expensesCount,

    totalCents,

    totalExpensesCents,

    // agrupamentos
    totalPorCategoria: Array.from(totalPorCategoria.entries()).map(([category, cents]) => ({
      category,
      totalCents: cents,
      total: cents,
    })),

    totalPorDia: Array.from(totalPorDia.entries()).map(([date, cents]) => ({
      date,
      totalCents: cents,
      total: cents,
    })),

    // planejamento
    salaryCents,
    extrasCents,
    fixedPlannedTotalCents,

    // resumo
    receitasCents,
    gastosCaixaCents,
    gastosCreditoCents,

    cardPaymentsCents,

    saldoEmContaCents,

    balanceCents,

    forecastBalanceCents,
  };
}
