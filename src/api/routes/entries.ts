import type { Prisma } from "@prisma/client";
import { Router } from "express";

import { prisma } from "../../db/prisma";
import { getOrCreateCategory } from "../../services/categoryService";
import { dayjs, TZ, normalizeDateOnly } from "../../utils/dates";
import { AuthedRequest } from "../middleware/auth";
import { getMonthRangeFromMonthYear, getMonthRangeTZ, parseFromToQuery } from "../../utils/dateRange";
import { assertValidAmountCents, centsToNumber, toAmountCents } from "../../utils/money";
import { DEFAULT_PAYMENT_METHOD, normalizePaymentMethod, PaymentMethod } from "../../utils/paymentMethod";
import {
  CARD_SELECT,
  CardSummary,
  findCardByIdForUser,
} from "../../services/cardService";

const router = Router();

function parseDateOnly(dateStr: unknown): Date | null {
  if (typeof dateStr !== "string") return null;
  const normalized = normalizeDateOnly(dateStr, TZ);
  return normalized;
}

function mapCard(card: CardSummary | null | undefined) {
  if (!card) return null;
  return {
    id: card.id,
    name: card.name,
    brand: card.brand,
    color: card.color,
  };
}

function mapExpense(expense: {
  id: number;
  amountCents: number;
  paymentMethod: PaymentMethod;
  cardId: number | null;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
  card?: CardSummary | null;
}) {
  const amountCents = assertValidAmountCents(expense.amountCents, "expense.amountCents", { allowZero: true });
  return {
    id: expense.id,
    amount: centsToNumber(amountCents),
    paymentMethod: expense.paymentMethod,
    cardId: expense.cardId ?? null,
    card: mapCard(expense.card),
    description: expense.description,
    category: expense.category.name,
    date: dayjs(expense.date).tz(TZ).format("YYYY-MM-DD"),
    source: expense.source,
    rawText: expense.rawText,
    createdAt: expense.createdAt,
  };
}

const EXPENSE_SELECT = {
  id: true,
  amountCents: true,
  paymentMethod: true,
  cardId: true,
  description: true,
  date: true,
  source: true,
  rawText: true,
  createdAt: true,
  category: { select: { name: true } },
  card: { select: CARD_SELECT },
} as const;

async function resolveCardIdForUser(userId: number, value: unknown) {
  if (typeof value === "undefined") {
    return { cardId: undefined as number | null | undefined };
  }
  if (value === null) {
    return { cardId: null as number | null };
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: { status: 400, message: '"cardId" deve ser inteiro > 0' } };
  }

  const card = await findCardByIdForUser(userId, parsed);
  if (!card) {
    return { error: { status: 403, message: "Cartao nao pertence ao usuario" } };
  }

  return { cardId: card.id };
}

function parseMonthParam(value: unknown): { year: number; month: number } | null {
  if (Array.isArray(value)) {
    return parseMonthParam(value[0]);
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  return null;
}

router.get("/", async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { from, to, category, q } = req.query;
  const providedMonth = typeof req.query.month !== "undefined";
  const parsedMonth = parseMonthParam(req.query.month);
  if (providedMonth && !parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }

  const filters: Prisma.ExpenseWhereInput[] = [];
  filters.push({ userId: user.id });

  if (typeof req.query.source === "string" && req.query.source.trim()) {
    filters.push({ source: req.query.source.trim() });
  }

  if (parsedMonth) {
    const { start, endExclusive } = getMonthRangeFromMonthYear(parsedMonth.month, parsedMonth.year, TZ);
    filters.push({ date: { gte: start, lt: endExclusive } });
  } else {
    const { start, endExclusive, error } = parseFromToQuery(
      typeof from === "string" ? from : undefined,
      typeof to === "string" ? to : undefined,
    );
    if (error) {
      return res.status(400).json({ error });
    }

    if (start || endExclusive) {
      filters.push({
        date: { ...(start ? { gte: start } : {}), ...(endExclusive ? { lt: endExclusive } : {}) },
      });
    } else {
      const { start: monthStart, endExclusive: monthEndExclusive } = getMonthRangeTZ(new Date(), TZ);
      filters.push({ date: { gte: monthStart, lt: monthEndExclusive } });
    }
  }

  if (typeof category === "string" && category.trim()) {
    filters.push({ category: { name: { contains: category.trim(), mode: "insensitive" } } });
  }

  if (typeof q === "string" && q.trim()) {
    filters.push({
      OR: [
        { description: { contains: q.trim(), mode: "insensitive" } },
        { rawText: { contains: q.trim(), mode: "insensitive" } },
        { category: { name: { contains: q.trim(), mode: "insensitive" } } },
      ],
    });
  }

  if (typeof req.query.cardId !== "undefined") {
    const rawCardId = Array.isArray(req.query.cardId) ? req.query.cardId[0] : req.query.cardId;
    const parsed =
      typeof rawCardId === "number"
        ? rawCardId
        : typeof rawCardId === "string"
          ? Number.parseInt(rawCardId, 10)
          : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'Parametro "cardId" invalido' });
    }
    filters.push({ cardId: parsed });
  }

  const where: Prisma.ExpenseWhereInput = filters.length ? { AND: filters } : {};

  const expenses = await prisma.expense.findMany({
    where,
    select: EXPENSE_SELECT,
    orderBy: { date: "desc" },
  });

  const items = expenses.map(mapExpense);
  return res.json({ items });
});

router.get("/:id", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID invalido" });
  }

  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const expense = await prisma.expense.findFirst({
    where: { id, userId: user.id },
    select: EXPENSE_SELECT,
  });

  if (!expense) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  return res.json(mapExpense(expense));
});

router.post("/", async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { amount, description, category, date } = req.body ?? {};
  const paymentMethod = normalizePaymentMethod(req.body?.paymentMethod);
  if (typeof req.body?.paymentMethod !== "undefined" && !paymentMethod) {
    return res.status(400).json({ error: "paymentMethod invalido" });
  }

  const cardCheck = await resolveCardIdForUser(user.id, req.body?.cardId);
  if (cardCheck.error) {
    return res.status(cardCheck.error.status).json({ error: cardCheck.error.message });
  }

  const amountCents = toAmountCents(amount);
  if (!amountCents || amountCents <= 0) {
    return res.status(400).json({ error: "amount deve ser maior que zero" });
  }

  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({ error: "description e obrigatoria" });
  }

  if (typeof category !== "string" || !category.trim()) {
    return res.status(400).json({ error: "category e obrigatoria" });
  }

  const parsedDate = parseDateOnly(date);
  if (!parsedDate) {
    return res.status(400).json({ error: "date invalida. Use YYYY-MM-DD" });
  }

  const categoryRow = await getOrCreateCategory(user.id, category);

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: categoryRow.id,
      amountCents,
      paymentMethod: paymentMethod ?? DEFAULT_PAYMENT_METHOD,
      ...(typeof cardCheck.cardId !== "undefined" ? { cardId: cardCheck.cardId } : {}),
      description: description.trim(),
      date: parsedDate,
      rawText: description.trim(),
      source: "manual",
    },
    select: EXPENSE_SELECT,
  });

  return res.status(201).json(mapExpense(expense));
});

router.put("/:id", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID invalido" });
  }

  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { amount, description, category, date } = req.body ?? {};
  const paymentMethod = normalizePaymentMethod(req.body?.paymentMethod);
  if (typeof req.body?.paymentMethod !== "undefined" && !paymentMethod) {
    return res.status(400).json({ error: "paymentMethod invalido" });
  }

  const cardCheck = await resolveCardIdForUser(user.id, req.body?.cardId);
  if (cardCheck.error) {
    return res.status(cardCheck.error.status).json({ error: cardCheck.error.message });
  }

  if (
    typeof amount === "undefined" &&
    typeof description === "undefined" &&
    typeof category === "undefined" &&
    typeof date === "undefined" &&
    typeof req.body?.paymentMethod === "undefined" &&
    typeof req.body?.cardId === "undefined"
  ) {
    return res.status(400).json({ error: "Nenhum campo para atualizar" });
  }

  const data: Prisma.ExpenseUncheckedUpdateManyInput = {};

  if (typeof amount !== "undefined") {
    const amountCents = toAmountCents(amount);
    if (!amountCents || amountCents <= 0) {
      return res.status(400).json({ error: "amount deve ser maior que zero" });
    }
    data.amountCents = amountCents;
  }

  if (typeof description !== "undefined") {
    if (typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "description e obrigatoria" });
    }
    data.description = description.trim();
    data.rawText = description.trim();
  }

  if (typeof date !== "undefined") {
    const parsedDate = parseDateOnly(date);
    if (!parsedDate) {
      return res.status(400).json({ error: "date invalida. Use YYYY-MM-DD" });
    }
    data.date = parsedDate;
  }

  if (typeof category !== "undefined") {
    if (typeof category !== "string" || !category.trim()) {
      return res.status(400).json({ error: "category e obrigatoria" });
    }
    const categoryRow = await getOrCreateCategory(user.id, category);
    data.categoryId = categoryRow.id;
  }

  if (typeof req.body?.paymentMethod !== "undefined") {
    data.paymentMethod = paymentMethod!;
  }

  if (typeof cardCheck.cardId !== "undefined") {
    data.cardId = cardCheck.cardId;
  }

  const updated = await prisma.expense.updateMany({
    where: { id, userId: user.id },
    data,
  });

  if (!updated.count) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  const saved = await prisma.expense.findFirst({
    where: { id, userId: user.id },
    select: EXPENSE_SELECT,
  });

  if (!saved) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  return res.json(mapExpense(saved));
});

router.delete("/:id", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID invalido" });
  }

  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const deleted = await prisma.expense.deleteMany({ where: { id, userId: user.id } });
  if (!deleted.count) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }
  return res.status(204).send();
});

export default router;
