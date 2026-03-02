import { Prisma } from "@prisma/client";

import { prisma } from "../infra/db/prisma";
import { getMonthlySummary } from "./monthlySummaryService";
import { getPlanningByUserId } from "./planningService";
import { getMonthRangeFromIsoMonth } from "../utils/dateRange";
import { TZ, dayjs } from "../utils/dates";
import { centsToNumber } from "../utils/money";
import { getOpenCycle } from "./cardCycle";

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function sanitizeMonth(input?: string) {
  if (input && MONTH_PATTERN.test(input)) {
    return input;
  }
  return dayjs().tz(TZ).format("YYYY-MM");
}

function buildEntryDto(expense: {
  id: number;
  amountCents: number;
  category: { name: string };
  date: Date;
  description: string;
  paymentMethod: string;
  card?: { id: number; name: string } | null;
  source: string;
}) {
  return {
    id: expense.id,
    amount: centsToNumber(expense.amountCents),
    description: expense.description,
    category: expense.category.name,
    date: dayjs(expense.date).tz(TZ).format("YYYY-MM-DD"),
    paymentMethod: expense.paymentMethod,
    cardName: expense.card?.name ?? null,
    source: expense.source,
  };
}

export async function tool_getDashboardSummary(userId: number, month?: string) {
  const targetMonth = sanitizeMonth(month);
  return getMonthlySummary({ userId, month: targetMonth });
}

export async function tool_listEntriesByMonth(
  userId: number,
  month?: string,
  options?: {
    limit?: number;
    filters?: { category?: string; source?: string };
    orderBy?: Prisma.ExpenseOrderByWithRelationInput[];
  },
) {
  const targetMonth = sanitizeMonth(month);
  const { start, endExclusive } = getMonthRangeFromIsoMonth(targetMonth, TZ);
  const where: Prisma.ExpenseWhereInput = {
    userId,
    date: { gte: start, lt: endExclusive },
  };
  if (options?.filters?.category) {
    where.category = { is: { name: { contains: options.filters.category, mode: "insensitive" } } };
  }
  if (options?.filters?.source) {
    where.source = options.filters.source;
  }
  const expenses = await prisma.expense.findMany({
    where,
    include: {
      category: { select: { name: true } },
      card: { select: { id: true, name: true } },
    },
    orderBy: options?.orderBy ?? [{ date: "desc" }, { createdAt: "desc" }],
    take: options?.limit,
  });
  return expenses.map(buildEntryDto);
}

export async function tool_getTopEntries(
  userId: number,
  month?: string,
  limit: number = 10,
) {
  const entries = await tool_listEntriesByMonth(userId, month, {
    limit,
    orderBy: [{ amountCents: "desc" }] as Prisma.ExpenseOrderByWithRelationInput[],
  });
  return entries;
}

async function fetchCardPaymentsForCycle(userId: number, cardId: number, cycleEndStart: Date) {
  try {
    return await prisma.cardPayment.findMany({
      where: {
        userId,
        cardId,
        cycleEnd: cycleEndStart,
      },
      orderBy: { createdAt: "asc" },
    });
  } catch (err: any) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.message.includes("CardPayment")) {
      console.warn("[ai][invoices] cardPayment table missing", err.message);
      return [];
    }
    throw err;
  }
}

export type OpenInvoiceSummary = {
  cardId: number;
  cardName: string;
  invoiceTotal: number;
  paid: number;
  remaining: number;
  cycleStart: string;
  cycleEnd: string;
  dueDate: string;
  purchases: Array<{ description: string; amount: number; date: string }>;
};

export async function tool_getOpenInvoices(userId: number) {
  const reference = dayjs().tz(TZ);
  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });
  const invoices = await Promise.all(
    cards.map(async (card) => {
      const cycle = getOpenCycle(card, reference.toDate());
      const start = cycle.cycleStart.startOf("day");
      const end = cycle.cycleEnd.endOf("day");
      const purchases = await prisma.expense.findMany({
        where: {
          userId,
          cardId: card.id,
          paymentMethod: "CREDIT",
          date: { gte: start.toDate(), lte: end.toDate() },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      });
      const payments = await fetchCardPaymentsForCycle(userId, card.id, cycle.cycleEnd.startOf("day").toDate());
      const invoiceTotalCents = purchases.reduce((sum, item) => sum + item.amountCents, 0);
      const paidTotalCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const remaining = Math.max(0, invoiceTotalCents - paidTotalCents);
      return {
        cardId: card.id,
        cardName: card.name,
        invoiceTotal: centsToNumber(invoiceTotalCents),
        paid: centsToNumber(paidTotalCents),
        remaining: centsToNumber(remaining),
        cycleStart: start.format("YYYY-MM-DD"),
        cycleEnd: end.format("YYYY-MM-DD"),
        dueDate: cycle.dueDate.format("YYYY-MM-DD"),
        purchases: purchases.map((purchase) => ({
          description: purchase.description,
          amount: centsToNumber(purchase.amountCents),
          date: dayjs(purchase.date).tz(TZ).format("YYYY-MM-DD"),
          installmentCurrent: purchase.installmentCurrent,
          installmentTotal: purchase.installmentTotal      
        })),
      };
    }),
  );
  return invoices;
}

export async function tool_getPlanning(userId: number) {
  return getPlanningByUserId(userId);
}
