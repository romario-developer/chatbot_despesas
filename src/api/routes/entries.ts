import type { Prisma } from "@prisma/client";
import { Router } from "express";

import { prisma } from "../../db/prisma";
import { getOrCreateCategory } from "../../services/categoryService";
import { dayjs, TZ } from "../../utils/dates";
import { AuthedRequest } from "../middleware/auth";
import { resolveAuthUserId } from "../utils/authUser";
import { getOrCreateUser } from "../../services/userService";

const router = Router();

function centsToNumber(cents: number) {
  return Number((cents / 100).toFixed(2));
}

function parseAmountToCents(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);
  }

  if (typeof amount === "string") {
    const normalized = amount.replace(",", ".").trim();
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100);
  }

  return null;
}

function parseDateOnly(dateStr: unknown): Date | null {
  if (typeof dateStr !== "string") return null;
  const parsed = dayjs.tz(dateStr, "YYYY-MM-DD", TZ);
  if (!parsed.isValid()) return null;
  return parsed.startOf("day").toDate();
}

function mapExpense(expense: {
  id: number;
  amountCents: number;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
}) {
  return {
    id: expense.id,
    amount: centsToNumber(expense.amountCents),
    description: expense.description,
    category: expense.category.name,
    date: dayjs(expense.date).tz(TZ).format("YYYY-MM-DD"),
    source: expense.source,
    rawText: expense.rawText,
    createdAt: expense.createdAt,
  };
}

async function resolveUser(req: AuthedRequest) {
  const telegramId = resolveAuthUserId(req);
  return getOrCreateUser(telegramId);
}

router.get("/", async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);

  const { from, to, category, q } = req.query;

  const filters: Prisma.ExpenseWhereInput[] = [];
  filters.push({ userId: user.id, source: { not: "manual" } });

  const fromDate = from ? parseDateOnly(from) : null;
  if (from && !fromDate) {
    return res.status(400).json({ error: 'Parametro "from" invalido. Use YYYY-MM-DD.' });
  }

  const toDate = to ? parseDateOnly(to) : null;
  if (to && !toDate) {
    return res.status(400).json({ error: 'Parametro "to" invalido. Use YYYY-MM-DD.' });
  }

  if (fromDate || toDate) {
    filters.push({ date: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } });
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
    include: { category: true },
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

  const expense = await prisma.expense.findFirst({
    where: { id, userId: user.id },
    include: { category: true },
  });

  if (!expense) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  return res.json(mapExpense(expense));
});

router.post("/", async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);

  const { amount, description, category, date } = req.body ?? {};

  const amountCents = parseAmountToCents(amount);
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
      description: description.trim(),
      date: parsedDate,
      rawText: description.trim(),
      source: "manual",
    },
    include: { category: true },
  });

  return res.status(201).json(mapExpense(expense));
});

router.put("/:id", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID invalido" });
  }

  const user = await resolveUser(req);

  const { amount, description, category, date } = req.body ?? {};

  if (
    typeof amount === "undefined" &&
    typeof description === "undefined" &&
    typeof category === "undefined" &&
    typeof date === "undefined"
  ) {
    return res.status(400).json({ error: "Nenhum campo para atualizar" });
  }

  const existing = await prisma.expense.findFirst({ where: { id, userId: user.id }, include: { category: true } });
  if (!existing) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  const data: Prisma.ExpenseUpdateInput = {};

  if (typeof amount !== "undefined") {
    const amountCents = parseAmountToCents(amount);
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
    const categoryRow = await getOrCreateCategory(existing.userId, category);
    data.category = { connect: { id: categoryRow.id } };
  }

  const updated = await prisma.expense.update({
    where: { id },
    data,
    include: { category: true },
  });

  return res.json(mapExpense(updated));
});

router.delete("/:id", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID invalido" });
  }

  const user = await resolveUser(req);

  const existing = await prisma.expense.findFirst({ where: { id, userId: user.id }, include: { category: true } });
  if (!existing) {
    return res.status(404).json({ error: "Lancamento nao encontrado" });
  }

  await prisma.expense.delete({ where: { id } });
  return res.status(204).send();
});

export default router;
