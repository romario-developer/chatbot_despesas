import { prisma } from '../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { assertValidAmountCents } from '../utils/money';

export interface ParsedExpenseInput {
  amountCents: number;
  description: string;
  categoryName: string;
  date: Date;
  rawText: string;
}

export async function createExpense(userId: number, input: ParsedExpenseInput) {
  await ensureDefaultCategory(userId);
  const category = await getOrCreateCategory(userId, input.categoryName || 'Outros');
  const amountCents = assertValidAmountCents(input.amountCents, 'expense.amountCents');

  const expense = await prisma.expense.create({
    data: {
      userId,
      categoryId: category.id,
      amountCents,
      description: input.description || 'Sem descrição',
      date: input.date,
      rawText: input.rawText,
      source: 'telegram-text',
    },
  });

  return { expense, category, userId };
}

export async function findExpenseForUser(userId: number, expenseId: number) {
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, userId },
    include: { category: true },
  });
  return { userId, expense };
}

export async function updateExpenseAmount(userId: number, expenseId: number, amountCents: number) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;
  const normalizedCents = assertValidAmountCents(amountCents, 'amountCents');

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { amountCents: normalizedCents },
    include: { category: true },
  });

  return { userId, expense: updated };
}

export async function updateExpenseDescription(
  userId: number,
  expenseId: number,
  description: string,
) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { description: description.trim() || 'Sem descrição' },
    include: { category: true },
  });

  return { userId, expense: updated };
}

export async function updateExpenseCategory(userId: number, expenseId: number, categoryName: string) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;

  const category = await getOrCreateCategory(userId, categoryName);
  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { categoryId: category.id },
    include: { category: true },
  });

  return { userId, expense: updated, category };
}

export async function updateExpenseDate(userId: number, expenseId: number, date: Date) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { date },
    include: { category: true },
  });

  return { userId, expense: updated };
}

export async function deleteExpense(userId: number, expenseId: number) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;

  await prisma.expense.delete({ where: { id: expense.id } });
  return { userId, expense };
}

export async function deleteExpensesForMonth(userId: number, month: number, year: number) {
  const { start, endExclusive } = getMonthRangeFromMonthYear(month, year);

  const aggregate = await prisma.expense.aggregate({
    where: {
      userId,
      date: { gte: start, lt: endExclusive },
    },
    _count: true,
    _sum: { amountCents: true },
  });

  const deleted = await prisma.expense.deleteMany({
    where: {
      userId,
      date: { gte: start, lt: endExclusive },
    },
  });

  return {
    userId,
    deletedCount: deleted.count,
    totalCents: aggregate._sum.amountCents ?? 0,
  };
}
