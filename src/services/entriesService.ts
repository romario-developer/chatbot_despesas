import type { Prisma } from '@prisma/client';
import { dayjs, normalizeDateOnly, TZ } from '../utils/dates';
import { prisma } from '../infra/db/prisma';
import { ApiError } from '../errors/ApiError';
import { DEFAULT_PAYMENT_METHOD, normalizePaymentMethod } from '../utils/paymentMethod';
import type { PaymentMethod } from '../utils/paymentMethod';
import { CARD_SELECT, CardSummary, findCardByIdForUser } from './cardService';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { classifyCategoryByText, learnCategoryMemory } from './categoryClassifier';
import { parseInstallmentPattern } from '../domain/installmentPattern';
import { createInstallmentExpenses } from './installmentService';
import { getInvoiceMonthForPurchase } from '../utils/installments';
import { assertValidAmountCents, centsToNumber, formatCurrencyNumber, toAmountCents } from '../utils/money';

const DEBUG_ENTRIES = process.env.DEBUG_ENTRIES === '1';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
  const amountCents = assertValidAmountCents(expense.amountCents, 'expense.amountCents', {
    allowZero: true,
  });
  return {
    id: expense.id,
    amount: centsToNumber(amountCents),
    paymentMethod: expense.paymentMethod,
    cardId: expense.cardId ?? null,
    card: mapCard(expense.card),
    description: expense.description,
    category: expense.category.name,
    date: dayjs(expense.date).tz(TZ).format('YYYY-MM-DD'),
    source: expense.source,
    rawText: expense.rawText,
    createdAt: expense.createdAt,
    categorySource: expense.categorySource ?? 'MANUAL',
  };
}

function parseDateOrThrow(value: string, label: string) {
  if (!DATE_ONLY_REGEX.test(value)) {
    throw new ApiError(`${label} deve usar o formato YYYY-MM-DD`, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const parsed = normalizeDateOnly(value, TZ);
  if (!parsed) {
    throw new ApiError(`${label} invalida. Use YYYY-MM-DD`, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return parsed;
}

function buildDateRange(fromStr: string, toStr: string) {
  const start = parseDateOrThrow(fromStr, 'from');
  const end = parseDateOrThrow(toStr, 'to');
  const startOfDay = dayjs(start).tz(TZ).startOf('day').toDate();
  const endOfDay = dayjs(end).tz(TZ).endOf('day').toDate();
  if (startOfDay.getTime() > endOfDay.getTime()) {
    throw new ApiError('"from" deve ser anterior ou igual a "to"', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return { start: startOfDay, end: endOfDay };
}

function resolvePaymentMethod(
  payment: string | undefined | null,
  method: string | undefined | null,
): PaymentMethod | null {
  const normalizedPayment = payment ? normalizePaymentMethod(payment) : null;
  const normalizedMethod = method ? normalizePaymentMethod(method) : null;

  if (payment && !normalizedPayment) {
    throw new ApiError('"payment" invalido', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (method && !normalizedMethod) {
    throw new ApiError('"paymentMethod" invalido', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (normalizedMethod && normalizedPayment && normalizedMethod !== normalizedPayment) {
    throw new ApiError(
      'Parametros "payment" e "paymentMethod" estao em conflito; use apenas um ou coloque o mesmo valor em ambos',
      { statusCode: 400, code: 'VALIDATION_ERROR' },
    );
  }
  return normalizedMethod ?? normalizedPayment ?? null;
}

async function resolveCardIdForUser(userId: number, cardId: number | null | undefined) {
  if (cardId === undefined) {
    return { cardId: undefined as number | null | undefined, card: null };
  }
  if (cardId === null) {
    return { cardId: null as number | null, card: null };
  }
  const card = await findCardByIdForUser(userId, cardId);
  if (!card) {
    throw new ApiError('Cartao nao pertence ao usuario', {
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  }
  return { cardId: card.id, card };
}

export interface EntryListParams {
  userId: number;
  from: string;
  to: string;
  category?: string;
  q?: string;
  source?: string;
  cardId?: number | null;
  payment?: string;
  paymentMethod?: string;
}

export interface EntryDto {
  id: number;
  amount: number;
  paymentMethod: string;
  cardId: number | null;
  card: ReturnType<typeof mapCard>;
  description: string;
  category: string;
  date: string;
  source: string;
  rawText: string;
  createdAt: Date;
  categorySource: string;
}

export async function listUserEntries(params: EntryListParams) {
  const { userId, category, q, source, cardId, from, to, payment, paymentMethod } = params;
  const { start, end } = buildDateRange(from, to);
  const filters: Prisma.ExpenseWhereInput[] = [
    { userId },
    { date: { gte: start, lte: end } },
  ];

  if (source) {
    filters.push({ source });
  }
  if (typeof cardId !== 'undefined') {
    filters.push({ cardId });
  }
  if (category) {
    filters.push({ category: { name: { contains: category, mode: 'insensitive' } } });
  }
  if (q) {
    filters.push({
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        { rawText: { contains: q, mode: 'insensitive' } },
        { category: { name: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  const selectedPaymentMethod = resolvePaymentMethod(payment, paymentMethod);
  if (selectedPaymentMethod) {
    filters.push({ paymentMethod: selectedPaymentMethod });
  }

  const where: Prisma.ExpenseWhereInput = { AND: filters };

  const expenses = await prisma.expense.findMany({
    where,
    include: { category: true, card: { select: CARD_SELECT } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  if (DEBUG_ENTRIES) {
    console.log(
      '[entries][debug] items',
      expenses.map((expense) => ({
        id: expense.id,
        description: expense.description,
        amount: centsToNumber(expense.amountCents),
        date: expense.date.toISOString(),
        createdAt: expense.createdAt,
        deletedAt: null,
        status: null,
        paymentMethod: expense.paymentMethod,
        cardId: expense.cardId ?? null,
        userId: expense.userId,
      })),
    );
  }

  console.log('[entries] ok', { from, to, count: expenses.length });
  return { items: expenses.map(mapExpense) };
}

export async function getUserEntryById(userId: number, entryId: number) {
  const expense = await prisma.expense.findFirst({
    where: { id: entryId, userId },
    include: { category: true, card: { select: CARD_SELECT } },
  });
  if (!expense) {
    throw new ApiError('Lancamento nao encontrado', { statusCode: 404, code: 'NOT_FOUND' });
  }
  return mapExpense(expense);
}

export interface CreateEntryPayload {
  amount: number;
  description: string;
  date: string;
  category?: string;
  paymentMethod?: string;
  cardId?: number | null;
  installments?: number;
}

export interface InstallmentCreateResult {
  createdCount: number;
  installmentGroupId: string;
  createdIds: number[];
  summary: string;
  entries: EntryDto[];
}

export type CreateEntryResult = EntryDto | InstallmentCreateResult;

function buildInstallmentSummary(description: string, totalCents: number, installments: number) {
  const totalAmount = centsToNumber(totalCents);
  const installmentAmount = Number((totalAmount / installments).toFixed(2));
  return `${description} — ${formatCurrencyNumber(totalAmount)} em ${installments}x (${formatCurrencyNumber(
    installmentAmount,
  )}/mês)`;
}

export async function createManualEntry(userId: number, input: CreateEntryPayload) {
  const amountCents = toAmountCents(input.amount);
  if (!amountCents || amountCents <= 0) {
    throw new ApiError('amount deve ser maior que zero', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const parsedDate = parseDateOrThrow(input.date, 'date');
  const descriptionText = input.description.trim();
  const parcelInfo = parseInstallmentPattern(descriptionText);

  let categoryId: number;
  let categorySource: 'MANUAL' | 'MEMORY' | 'RULE' | 'NONE' = 'NONE';

  if (input.category && input.category.trim()) {
    const categoryRow = await getOrCreateCategory(userId, input.category);
    categoryId = categoryRow.id;
    categorySource = 'MANUAL';
    await learnCategoryMemory(userId, descriptionText, categoryRow.id);
  } else {
    const classification = await classifyCategoryByText(userId, descriptionText);
    if (classification) {
      categoryId = classification.categoryId;
      categorySource = classification.source;
    } else {
      const fallback = await ensureDefaultCategory(userId);
      categoryId = fallback.id;
    }
  }

  const installments = input.installments ?? 1;
  const normalizedPaymentMethod = normalizePaymentMethod(input.paymentMethod) ?? DEFAULT_PAYMENT_METHOD;
  const finalPaymentMethod = installments > 1 ? 'CREDIT' : normalizedPaymentMethod;

  const cardResolution = await resolveCardIdForUser(userId, input.cardId);
  if (finalPaymentMethod === 'CREDIT' && cardResolution.cardId === null) {
    throw new ApiError('"cardId" e obrigatorio para paymentMethod=CREDIT', {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  if (installments > 1) {
    if (cardResolution.cardId === undefined || cardResolution.cardId === null || !cardResolution.card) {
      throw new ApiError('"cardId" e obrigatorio para pagamento com parcelas', {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }

    const { groupId, expenses } = await createInstallmentExpenses({
      userId,
      cardId: cardResolution.cardId,
      categoryId,
      description: descriptionText,
      amountCents,
      date: parsedDate,
      rawText: descriptionText,
      purchaseLabel: parcelInfo.purchaseLabel ?? descriptionText,
      paymentMethod: 'CREDIT',
      source: 'manual',
      installmentsTotal: installments,
      appendInstallmentLabel: true,
      closingDay: cardResolution.card.closingDay ?? 1,
    });

    console.log('[entries] created installments', {
      groupId,
      userId,
      amountCents,
      installments,
    });

    return {
      createdCount: expenses.length,
      installmentGroupId: groupId,
      createdIds: expenses.map((expense) => expense.id),
      summary: buildInstallmentSummary(descriptionText, amountCents, installments),
      entries: expenses.map(mapExpense),
    };
  }

  const invoiceMonth =
    cardResolution.card && cardResolution.card.closingDay
      ? getInvoiceMonthForPurchase(parsedDate, cardResolution.card.closingDay)
      : dayjs(parsedDate).tz(TZ).format('YYYY-MM');

  const expense = await prisma.expense.create({
    data: {
      userId,
      categoryId,
      amountCents,
      paymentMethod: finalPaymentMethod,
      ...(cardResolution.cardId !== null && cardResolution.cardId !== undefined
        ? { cardId: cardResolution.cardId }
        : {}),
      description: descriptionText,
      date: parsedDate,
      rawText: descriptionText,
      source: 'manual',
      categorySource,
      purchaseLabel: parcelInfo.purchaseLabel ?? descriptionText,
      postedMonth: invoiceMonth,
      invoiceMonth,
      installmentCurrent: parcelInfo.current ?? null,
      installmentTotal: parcelInfo.total ?? null,
      installmentIndex: 1,
      installmentsTotal: installments,
    },
    include: { category: true, card: { select: CARD_SELECT } },
  });

  console.log('[entries] created', {
    id: expense.id,
    userId,
    paymentMethod: expense.paymentMethod,
    cardId: expense.cardId,
    amountCents: expense.amountCents,
  });

  return mapExpense(expense);
}

export interface UpdateEntryPayload {
  amount?: number;
  description?: string;
  date?: string;
  category?: string;
  paymentMethod?: string;
  cardId?: number | null;
}

export async function updateManualEntry(userId: number, entryId: number, payload: UpdateEntryPayload) {
  const existing = await prisma.expense.findFirst({
    where: { id: entryId, userId },
    select: { description: true, categoryId: true },
  });
  if (!existing) {
    throw new ApiError('Lancamento nao encontrado', { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data: Prisma.ExpenseUncheckedUpdateInput = {};
  let manualCategoryId: number | null = null;
  let manualDescriptionText: string | null = null;

  if (typeof payload.amount !== 'undefined') {
    const amountCents = toAmountCents(payload.amount);
    if (!amountCents || amountCents <= 0) {
      throw new ApiError('amount deve ser maior que zero', {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    data.amountCents = amountCents;
  }

  if (typeof payload.description !== 'undefined') {
    data.description = payload.description;
    data.rawText = payload.description;
    manualDescriptionText = payload.description;
  }

  if (typeof payload.date !== 'undefined') {
    data.date = parseDateOrThrow(payload.date, 'date');
  }

  if (typeof payload.paymentMethod !== 'undefined') {
    const normalized = normalizePaymentMethod(payload.paymentMethod);
    if (!normalized) {
      throw new ApiError('"paymentMethod" invalido', { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    data.paymentMethod = normalized;
  }

  if (typeof payload.category !== 'undefined') {
    if (!payload.category.trim()) {
      throw new ApiError('category e obrigatoria', { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    const categoryRow = await getOrCreateCategory(userId, payload.category);
    data.categoryId = categoryRow.id;
    data.categorySource = 'MANUAL';
    manualCategoryId = categoryRow.id;
    manualDescriptionText = manualDescriptionText ?? existing.description;
  }

  if (typeof payload.cardId !== 'undefined') {
    const cardResolution = await resolveCardIdForUser(userId, payload.cardId);
    data.cardId = cardResolution.cardId;
  }

  const updated = await prisma.expense.update({
    where: { id: entryId, userId },
    data,
    include: { category: true, card: { select: CARD_SELECT } },
  });

  if (manualCategoryId && manualDescriptionText) {
    await learnCategoryMemory(userId, manualDescriptionText, manualCategoryId);
  }

  return mapExpense(updated);
}

export async function deleteUserEntry(userId: number, entryId: number) {
  const deleted = await prisma.expense.deleteMany({ where: { id: entryId, userId } });
  if (!deleted.count) {
    throw new ApiError('Lancamento nao encontrado', { statusCode: 404, code: 'NOT_FOUND' });
  }
}
