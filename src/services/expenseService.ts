import { prisma } from '../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { getOrCreateUser } from './userService';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { assertValidAmountCents } from '../utils/money';

export interface ParsedExpenseInput {
  amountCents: number;
  description: string;
  categoryName: string;
  date: Date;
  rawText: string;
}

export async function createExpense(telegramId: string, input: ParsedExpenseInput) {
  const user = await getOrCreateUser(telegramId);
  await ensureDefaultCategory(user.id);
  const category = await getOrCreateCategory(user.id, input.categoryName || 'Outros');
  const amountCents = assertValidAmountCents(input.amountCents, 'expense.amountCents');

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents,
      description: input.description || 'Sem descrição',
      date: input.date,
      rawText: input.rawText,
      source: 'telegram-text',
    },
  });

  return { expense, category, user };
}

export async function findExpenseForUser(telegramId: string, expenseId: number) {
  const user = await getOrCreateUser(telegramId);
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, userId: user.id },
    include: { category: true },
  });
  return { user, expense };
}

export async function updateExpenseAmount(telegramId: string, expenseId: number, amountCents: number) {
  const { user, expense } = await findExpenseForUser(telegramId, expenseId);
  if (!expense) return null;
  const normalizedCents = assertValidAmountCents(amountCents, 'amountCents');

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { amountCents: normalizedCents },
    include: { category: true },
  });

  return { user, expense: updated };
}

export async function updateExpenseDescription(
  telegramId: string,
  expenseId: number,
  description: string,
) {
  const { user, expense } = await findExpenseForUser(telegramId, expenseId);
  if (!expense) return null;

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { description: description.trim() || 'Sem descrição' },
    include: { category: true },
  });

  return { user, expense: updated };
}

export async function updateExpenseCategory(telegramId: string, expenseId: number, categoryName: string) {
  const { user, expense } = await findExpenseForUser(telegramId, expenseId);
  if (!expense) return null;

  const category = await getOrCreateCategory(user.id, categoryName);
  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { categoryId: category.id },
    include: { category: true },
  });

  return { user, expense: updated, category };
}

export async function updateExpenseDate(telegramId: string, expenseId: number, date: Date) {
  const { user, expense } = await findExpenseForUser(telegramId, expenseId);
  if (!expense) return null;

  const updated = await prisma.expense.update({
    where: { id: expense.id },
    data: { date },
    include: { category: true },
  });

  return { user, expense: updated };
}

export async function deleteExpense(telegramId: string, expenseId: number) {
  const { user, expense } = await findExpenseForUser(telegramId, expenseId);
  if (!expense) return null;

  await prisma.expense.delete({ where: { id: expense.id } });
  return { user, expense };
}

export async function deleteExpensesForMonth(telegramId: string, month: number, year: number) {
  const user = await getOrCreateUser(telegramId);
  const { start, endExclusive } = getMonthRangeFromMonthYear(month, year);

  const aggregate = await prisma.expense.aggregate({
    where: {
      userId: user.id,
      date: { gte: start, lt: endExclusive },
    },
    _count: true,
    _sum: { amountCents: true },
  });

  const deleted = await prisma.expense.deleteMany({
    where: {
      userId: user.id,
      date: { gte: start, lt: endExclusive },
    },
  });

  return {
    user,
    deletedCount: deleted.count,
    totalCents: aggregate._sum.amountCents ?? 0,
  };
}
