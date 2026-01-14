import type { Prisma } from "@prisma/client";
import { Router } from "express";

import { prisma } from "../../db/prisma";
import { ensureDefaultCategory, getOrCreateCategory } from "../../services/categoryService";
import { classifyCategoryByText, learnCategoryMemory } from "../../services/categoryClassifier";
import { dayjs, TZ, normalizeDateOnly } from "../../utils/dates";
import { AuthedRequest } from "../middleware/auth";
import { assertValidAmountCents, centsToNumber, toAmountCents } from "../../utils/money";
import { DEFAULT_PAYMENT_METHOD, normalizePaymentMethod } from "../../utils/paymentMethod";
import {
  CARD_SELECT,
  CardSummary,
  findCardByIdForUser,
} from "../../services/cardService";
import { parseInstallmentPattern } from "../../domain/installmentPattern";

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
  paymentMethod: string;
  cardId: number | null;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
  card?: CardSummary | null;
  categorySource?: string | null;
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
    categorySource: expense.categorySource ?? "MANUAL",
  };
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type DateRangeValidationResult =
  | { fromDate: Date; toDate: Date }
  | { detail: string };

function buildDateRange(fromValue: string, toValue: string): DateRangeValidationResult {
  const fromStr = typeof fromValue === "string" ? fromValue.trim() : "";
  const toStr = typeof toValue === "string" ? toValue.trim() : "";

  // Validate format with regex
  if (!DATE_ONLY_REGEX.test(fromStr)) {
    return { detail: '"from" deve usar o formato YYYY-MM-DD' };
  }
  if (!DATE_ONLY_REGEX.test(toStr)) {
    return { detail: '"to" deve usar o formato YYYY-MM-DD' };
  }

  // Parse strictly with timezone
  const from = dayjs.tz(fromStr, "YYYY-MM-DD", TZ);
  const to = dayjs.tz(toStr, "YYYY-MM-DD", TZ);

  if (!from.isValid()) {
    return { detail: '"from" data inválida' };
  }
  if (!to.isValid()) {
    return { detail: '"to" data inválida' };
  }

  // Build date range with start and end of day
  const fromDate = from.startOf("day").toDate();
  const toDate = to.endOf("day").toDate();

  if (fromDate.getTime() > toDate.getTime()) {
    return { detail: '"from" precisa ser anterior ou igual a "to"' };
  }

  return { fromDate, toDate };
}

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

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  return null;
}

router.get("/", async (req: AuthedRequest, res) => {
  let logFrom: string | undefined;
  let logTo: string | undefined;
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { category, q, source } = req.query;
    const rawFrom = Array.isArray(req.query.from) ? req.query.from[0] : req.query.from;
    const rawTo = Array.isArray(req.query.to) ? req.query.to[0] : req.query.to;
    const trimmedFrom = typeof rawFrom === "string" ? rawFrom.trim() : "";
    const trimmedTo = typeof rawTo === "string" ? rawTo.trim() : "";
    
    logFrom = trimmedFrom || undefined;
    logTo = trimmedTo || undefined;

    // Validate and parse date range
    if (!trimmedFrom || !trimmedTo) {
      return res.status(400).json({ 
        error: "Invalid date range",
        details: { from: trimmedFrom || null, to: trimmedTo || null }
      });
    }

    const validatedRange = buildDateRange(trimmedFrom, trimmedTo);
    if ("detail" in validatedRange) {
      console.log("[entries] invalid date range", { from: trimmedFrom, to: trimmedTo, detail: validatedRange.detail });
      return res.status(400).json({ 
        error: "Invalid date range",
        details: validatedRange.detail
      });
    }

    const { fromDate, toDate } = validatedRange;
    console.log("[entries] date range parsed", { 
      from: trimmedFrom, 
      to: trimmedTo, 
      fromDate: fromDate.toISOString(), 
      toDate: toDate.toISOString() 
    });

    const filters: Prisma.ExpenseWhereInput[] = [
      { userId: user.id },
      { date: { gte: fromDate, lte: toDate } },
    ];

    if (typeof source === "string" && source.trim()) {
      filters.push({ source: source.trim() });
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

    const where: Prisma.ExpenseWhereInput = filters.length ? { AND: filters } : {};

    const expenses = await prisma.expense.findMany({
      where,
      include: { category: true, card: { select: CARD_SELECT } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const items = expenses.map(mapExpense);
    console.log("[entries] ok", { from: trimmedFrom, to: trimmedTo, count: items.length });
    return res.json({ items });
  } catch (err) {
    console.error(
      "[entries] failed",
      { from: logFrom ?? null, to: logTo ?? null },
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    return res.status(500).json({ error: "Failed to fetch entries", code: "ENTRIES_LIST_FAILED" });
  }
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
    include: { category: true, card: { select: CARD_SELECT } },
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

  const parsedDate = parseDateOnly(date);
  if (!parsedDate) {
    return res.status(400).json({ error: "date invalida. Use YYYY-MM-DD" });
  }
  const descriptionText = description.trim();

  let categoryId: number;
  let categorySource: "MANUAL" | "MEMORY" | "RULE" | "NONE" = "NONE";

  if (typeof category === "string" && category.trim()) {
    const categoryRow = await getOrCreateCategory(user.id, category);
    categoryId = categoryRow.id;
    categorySource = "MANUAL";
    await learnCategoryMemory(user.id, descriptionText, categoryRow.id);
  } else {
    const classification = await classifyCategoryByText(user.id, descriptionText);
    if (classification) {
      categoryId = classification.categoryId;
      categorySource = classification.source;
    } else {
      const fallback = await ensureDefaultCategory(user.id);
      categoryId = fallback.id;
      categorySource = "NONE";
    }
  }

  const parcelInfo = parseInstallmentPattern(descriptionText);
  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId,
      amountCents,
      paymentMethod: paymentMethod ?? DEFAULT_PAYMENT_METHOD,
      ...(typeof cardCheck.cardId !== "undefined" ? { cardId: cardCheck.cardId } : {}),
      description: descriptionText,
      date: parsedDate,
      rawText: descriptionText,
      source: "manual",
      categorySource,
      purchaseLabel: parcelInfo.purchaseLabel ?? descriptionText,
      postedMonth: dayjs(parsedDate).tz(TZ).format("YYYY-MM"),
      installmentCurrent: parcelInfo.current ?? null,
      installmentTotal: parcelInfo.total ?? null,
    },
    include: { category: true, card: { select: CARD_SELECT } },
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

  const existingExpense = await prisma.expense.findFirst({
    where: { id, userId: user.id },
    select: { description: true },
  });
  if (!existingExpense) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
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
  let manualCategoryId: number | null = null;
  let manualDescriptionText: string | null = null;

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

  if (typeof req.body?.paymentMethod !== "undefined") {
    data.paymentMethod = paymentMethod!;
  }

  if (typeof category !== "undefined") {
    if (typeof category !== "string" || !category.trim()) {
      return res.status(400).json({ error: "category e obrigatoria" });
    }
    const categoryRow = await getOrCreateCategory(user.id, category);
    data.categoryId = categoryRow.id;
    data.categorySource = "MANUAL";
    manualCategoryId = categoryRow.id;
    manualDescriptionText =
      typeof description === "string" && description.trim() ? description.trim() : existingExpense.description;
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

  if (manualCategoryId && manualDescriptionText) {
    await learnCategoryMemory(user.id, manualDescriptionText, manualCategoryId);
  }

  const saved = await prisma.expense.findFirst({
    where: { id, userId: user.id },
    include: { category: true, card: { select: CARD_SELECT } },
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
