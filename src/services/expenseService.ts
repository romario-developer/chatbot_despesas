import type { Expense, PaymentMethod, Prisma } from '@prisma/client';

import { prisma } from '../infra/db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { getMonthRangeFromMonthYear } from '../utils/dateRange';
import { dayjs, TZ } from '../utils/dates';
import { assertValidAmountCents } from '../utils/money';
import { BackupAction } from '@prisma/client';
import { createBackupEvent } from './backupEventService';

export interface ParsedExpenseInput {
  amountCents: number;
  description: string;
  categoryName: string;
  date: Date;
  rawText: string;
  paymentMethod?: PaymentMethod;
  cardId?: number | null;
  installmentsTotal?: number;
  installmentIndex?: number | null;
  installmentCurrent?: number | null;
  installmentTotal?: number | null;
  installmentGroupId?: string | null;
  invoiceMonth?: string | null;
  postedMonth?: string | null;
  source?: string;
  purchaseLabel?: string;
}

export async function createExpense(userId: number, input: ParsedExpenseInput) {
  await ensureDefaultCategory(userId);
  const category = await getOrCreateCategory(userId, input.categoryName || 'Outros');
  const amountCents = assertValidAmountCents(input.amountCents, 'expense.amountCents');

  const normalizedDescription = input.description || 'Sem descrição';

  const expense = await prisma.expense.create({
    data: {
      userId,
      categoryId: category.id,
      amountCents,
      paymentMethod: input.paymentMethod ?? 'OTHER',
      cardId: input.cardId ?? undefined,
      description: normalizedDescription,
      date: input.date,
      rawText: input.rawText,
      source: input.source ?? 'api',
      purchaseLabel: input.purchaseLabel ?? normalizedDescription,
      postedMonth: input.postedMonth ?? dayjs(input.date).tz(TZ).format('YYYY-MM'),
      invoiceMonth:
        input.invoiceMonth ??
        input.postedMonth ??
        dayjs(input.date).tz(TZ).format('YYYY-MM'),
      installmentGroupId: input.installmentGroupId ?? null,
      installmentIndex: input.installmentIndex ?? 1,
      installmentsTotal: input.installmentsTotal ?? 1,
      installmentCurrent: input.installmentCurrent ?? null,
      installmentTotal: input.installmentTotal ?? null,
    },
  });

  await logExpenseCreate(userId, expense);

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

  await logExpenseUpdate(userId, expense, updated);

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

  await logExpenseUpdate(userId, expense, updated);

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

  await logExpenseUpdate(userId, expense, updated);

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

  await logExpenseUpdate(userId, expense, updated);

  return { userId, expense: updated };
}

export async function deleteExpense(userId: number, expenseId: number) {
  const { expense } = await findExpenseForUser(userId, expenseId);
  if (!expense) return null;

  if (expense.installmentGroupId) {
    const groupId = expense.installmentGroupId;
    const groupExpenses = await prisma.expense.findMany({ where: { installmentGroupId: groupId } });
    await prisma.$transaction([
      prisma.expense.deleteMany({ where: { installmentGroupId: groupId } }),
      prisma.installmentGroup.deleteMany({ where: { id: groupId } }),
    ]);
    await Promise.all(groupExpenses.map((entry) => logExpenseDelete(userId, entry)));
    return { userId, expense: null };
  }

  const deleted = await prisma.expense.delete({ where: { id: expense.id } });
  await logExpenseDelete(userId, deleted);
  return { userId, expense: deleted };
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

async function logExpenseCreate(userId: number, expense: Expense) {
  await createBackupEvent({
    userId,
    entity: 'expense',
    entityId: expense.id,
    action: BackupAction.CREATE,
    payload: {
      after: snapshotExpense(expense) as Prisma.InputJsonValue,
    },
  });
}

async function logExpenseUpdate(userId: number, beforeExpense: Expense, afterExpense: Expense) {
  const beforeSnapshot = snapshotExpense(beforeExpense);
  const afterSnapshot = snapshotExpense(afterExpense);
  const diff = diffExpenseSnapshots(beforeSnapshot, afterSnapshot);
  if (!diff.updatedFields.length) return;

  await createBackupEvent({
    userId,
    entity: 'expense',
    entityId: afterExpense.id,
    action: BackupAction.UPDATE,
    payload: {
      updatedFields: diff.updatedFields,
      before: diff.before as Prisma.InputJsonValue,
      after: diff.after as Prisma.InputJsonValue,
    },
  });
}

async function logExpenseDelete(userId: number, expense: Expense) {
  await createBackupEvent({
    userId,
    entity: 'expense',
    entityId: expense.id,
    action: BackupAction.DELETE,
    payload: {
      before: snapshotExpense(expense) as Prisma.InputJsonValue,
    },
  });
}

type ExpenseSnapshot = Record<string, unknown>;
type JsonRecord = Record<string, Prisma.InputJsonValue | null>;
const TRACKED_EXPENSE_FIELDS = [
  'amountCents',
  'description',
  'categoryId',
  'cardId',
  'paymentMethod',
  'source',
  'purchaseLabel',
  'postedMonth',
  'invoiceMonth',
  'installmentGroupId',
  'installmentIndex',
  'installmentsTotal',
  'rawText',
  'date',
] as const;

function snapshotExpense(expense: Expense): ExpenseSnapshot {
  return {
    id: expense.id,
    amountCents: expense.amountCents,
    description: expense.description,
    categoryId: expense.categoryId,
    cardId: expense.cardId,
    paymentMethod: expense.paymentMethod,
    source: expense.source,
    rawText: expense.rawText,
    purchaseLabel: expense.purchaseLabel,
    postedMonth: expense.postedMonth,
    invoiceMonth: expense.invoiceMonth,
    installmentGroupId: expense.installmentGroupId,
    installmentIndex: expense.installmentIndex,
    installmentsTotal: expense.installmentsTotal,
    date: expense.date.toISOString(),
  };
}

function diffExpenseSnapshots(
  before: ExpenseSnapshot,
  after: ExpenseSnapshot,
): { updatedFields: string[]; before: JsonRecord; after: JsonRecord } {
  const updatedFields: string[] = [];
  const beforePayload: JsonRecord = {};
  const afterPayload: JsonRecord = {};

  TRACKED_EXPENSE_FIELDS.forEach((field) => {
    const beforeValue = normalizeValue(before[field]);
    const afterValue = normalizeValue(after[field]);
    if (beforeValue !== afterValue) {
      updatedFields.push(field);
      beforePayload[field] = beforeValue;
      afterPayload[field] = afterValue;
    }
  });

  return { updatedFields, before: beforePayload, after: afterPayload };
}

function normalizeValue(value: unknown): Prisma.InputJsonValue | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value ?? null;
}
