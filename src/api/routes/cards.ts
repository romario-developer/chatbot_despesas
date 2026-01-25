import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { dayjs, nowBahia, TZ } from '../../utils/dates';
import { centsToNumber, toAmountCents } from '../../utils/money';
import { parseFromToQuery } from '../../utils/dateRange';
import { cardToDto, InvoiceViewDto, logCardDebug } from '../../utils/cardDto';
import { Prisma } from '@prisma/client';
import type { Expense, CardPayment } from '@prisma/client';
import {
  getCardCycleForMonth,
  getOpenCycle,
  type CardCyclePeriod,
} from '../../services/cardCycle';
import type { AuthedRequest } from '../middleware/auth';

const router = Router();
const DEBUG_INVOICES = process.env.DEBUG_INVOICES === '1';

const BRAND_VALUES = new Set(['VISA', 'MASTERCARD', 'ELO', 'AMEX', 'OTHER']);
const DEFAULT_CARD_COLOR = '#4F46E5';

function normalizeQueryParam(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (!strings.length) return undefined;
    return strings.length === 1 ? strings[0] : strings;
  }
  return undefined;
}

async function fetchCardPaymentsForCycle(userId: number, cardId: number, cycleEndStart: Date) {
  try {
    return await prisma.cardPayment.findMany({
      where: {
        userId,
        cardId,
        cycleEnd: cycleEndStart,
      },
      orderBy: { createdAt: 'asc' },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.message.includes('CardPayment')
    ) {
      console.warn('[cards/invoices] cardPayment table missing, skipping payments', {
        cardId,
        error: err.message,
      });
      return [];
    }
    throw err;
  }
}

function logInvoiceDebug(
  cardId: number,
  closingDay: number,
  asOf: string,
  cycle: CardCyclePeriod,
  purchases: Expense[],
  payments: CardPayment[],
  invoiceTotalCents: number,
  paidTotalCents: number,
  remainingCents: number,
) {
  if (!DEBUG_INVOICES) return;
  console.log(
    '[cards/invoices] debug cardId=%s closingDay=%s asOf=%s cycleStart=%s cycleEnd=%s',
    cardId,
    closingDay,
    asOf,
    cycle.cycleStart.format('YYYY-MM-DD'),
    cycle.cycleEnd.format('YYYY-MM-DD'),
  );
  const entriesCount = purchases.length;
  const entryPayload = purchases.map((purchase) => ({
    id: purchase.id,
    date: dayjs(purchase.date).tz(TZ).format('YYYY-MM-DD'),
    amount: purchase.amountCents,
    description: purchase.description,
    createdAt: purchase.createdAt,
    deletedAt: null,
    status: null,
  }));
  console.log('[cards/invoices] entries count=%s details=%o', entriesCount, entryPayload);
  console.log('[cards/invoices] invoiceTotal=%s', centsToNumber(invoiceTotalCents));
  console.log(
    '[cards/invoices] payments %o',
    payments.map((payment) => ({
      id: payment.id,
      amount: payment.amountCents,
      cycleEnd: dayjs(payment.cycleEnd).tz(TZ).format('YYYY-MM-DD'),
    })),
  );
  console.log(
    '[cards/invoices] paidTotal=%s remaining=%s',
    centsToNumber(paidTotalCents),
    centsToNumber(remainingCents),
  );
}

function normalizeBrand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized || !BRAND_VALUES.has(normalized)) return null;
  return normalized;
}

function parseDay(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null;
    return value >= 1 && value <= 31 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isInteger(parsed)) return null;
    return parsed >= 1 && parsed <= 31 ? parsed : null;
  }
  return null;
}

function parseLimit(value: unknown): number | null {
  if (typeof value === 'undefined') return 0;
  const cents = toAmountCents(value);
  if (cents === null) return null;
  return cents >= 0 ? cents : null;
}

function parseHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!/^#([0-9A-F]{3}|[0-9A-F]{6})$/.test(normalized)) return null;
  return normalized;
}

function parseMonthParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) return null;
  return normalized;
}


router.get('/summary', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const providedMonth = typeof req.query.month !== 'undefined';
  const parsedMonth = parseMonthParam(req.query.month);
  if (providedMonth && !parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }
  const month = parsedMonth ?? nowBahia().tz(TZ).format('YYYY-MM');

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const dtos = cards.map(cardToDto);
  logCardDebug('/api/cards/summary', dtos, { month });
  const items = dtos.map((dto) => ({
    cardId: dto.id,
    ...dto,
    spentInMonth: 0,
  }));

  return res.json({ month, items });
});

// GET /api/cards/invoices?month=YYYY-MM|asOf=YYYY-MM-DD
// Retorna faturas calculadas pelo mês de fechamento (cycleEnd). Exemplo de resposta:
// {
//   "asOf": "2026-01-31",
//   "month": "2026-02",
//   "invoices": [
//     {
//       "card": {
//         "id": 1,
//         "userId": 7,
//         "name": "Visa Corporativo",
//         "brand": "VISA",
//         "limit": 5000,
//         "closingDay": 5,
//         "dueDay": 20,
//         "color": "#4F46E5",
//         "textColor": "#FFFFFF",
//         "createdAt": "2026-01-12T16:00:00.000Z",
//         "updatedAt": "2026-01-12T16:00:00.000Z"
//       },
//       "cardId": 1,
//       "cycleStart": "2026-01-05T00:00:00.000Z",
//       "cycleEnd": "2026-02-04T23:59:59.999Z",
//       "dueDate": "2026-02-20T00:00:00.000Z",
//       "entriesCount": 4,
//       "invoiceTotal": 1200,
//       "paidTotal": 600,
//       "remaining": 600,
//       "status": "OPEN"
//     }
//   ]
// }
router.get('/invoices', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const rawAsOf = Array.isArray(req.query.asOf) ? req.query.asOf[0] : req.query.asOf;
  const asOfString = typeof rawAsOf === 'string' ? rawAsOf.trim() : undefined;
  const asOfCandidate = asOfString ? dayjs.tz(asOfString, 'YYYY-MM-DD', TZ) : undefined;
  if (asOfString && (!asOfCandidate || !asOfCandidate.isValid())) {
    return res.status(400).json({ error: 'Parametro "asOf" invalido. Use YYYY-MM-DD.' });
  }

  const rawMonth = Array.isArray(req.query.month) ? req.query.month[0] : req.query.month;
  const providedMonth = typeof rawMonth !== 'undefined';
  const parsedMonth = parseMonthParam(rawMonth);
  if (providedMonth && !parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }

  const monthAsOfCandidate = parsedMonth
    ? dayjs.tz(`${parsedMonth}-01`, 'YYYY-MM-DD', TZ).endOf('month')
    : undefined;
  const asOfBase = monthAsOfCandidate ?? asOfCandidate ?? nowBahia().tz(TZ);
  const asOf = asOfBase.startOf('day');

  console.log(
    '[cards/invoices] userId=%s asOf=%s month=%s',
    userId,
    asOf.format('YYYY-MM-DD'),
    parsedMonth ?? 'n/a',
  );

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });
  const cardDtos = cards.map(cardToDto);
  logCardDebug('/api/cards/invoices', cardDtos, { month: parsedMonth, asOf: asOf.format('YYYY-MM-DD') });


  const invoices = await Promise.all(
    cards.map(async (card, index): Promise<InvoiceViewDto> => {
      const dto = cardDtos[index];
    const cycle =
      parsedMonth && parsedMonth
        ? getCardCycleForMonth(card, parsedMonth)
        : getOpenCycle(card, asOf.toDate());
    const rangeStart = cycle.cycleStart.startOf('day');
    const rangeEnd = cycle.cycleEnd.endOf('day');
    const purchases = await prisma.expense.findMany({
      where: {
        userId,
        cardId: card.id,
        paymentMethod: 'CREDIT',
        date: { gte: rangeStart.toDate(), lte: rangeEnd.toDate() },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    const payments = await fetchCardPaymentsForCycle(
      userId,
      card.id,
      cycle.cycleEnd.startOf('day').toDate(),
    );

      const invoiceTotalCents = purchases.reduce((sum, purchase) => sum + purchase.amountCents, 0);
      const paidTotalCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const remainingCents = Math.max(0, invoiceTotalCents - paidTotalCents);

      logInvoiceDebug(
        card.id,
        card.closingDay,
        asOf.format('YYYY-MM-DD'),
        cycle,
        purchases,
        payments,
        invoiceTotalCents,
        paidTotalCents,
        remainingCents,
      );

      const status =
        invoiceTotalCents === 0
          ? 'EMPTY'
          : remainingCents <= 0
            ? 'PAID'
            : 'OPEN';

      return {
        cardId: card.id,
        ...dto,
        card: dto,
        cycleStart: cycle.cycleStart.toISOString(),
        cycleEnd: cycle.cycleEnd.toISOString(),
        dueDate: cycle.dueDate.toISOString(),
        entriesCount: purchases.length,
        invoiceTotal: centsToNumber(invoiceTotalCents),
        paidTotal: centsToNumber(paidTotalCents),
        remaining: centsToNumber(remainingCents),
        status,
      };
    }),
  );

  return res.json({
    asOf: asOf.format('YYYY-MM-DD'),
    month: parsedMonth ?? asOf.format('YYYY-MM'),
    invoices,
  });
});

router.get('/invoices/open', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const reference = nowBahia().tz(TZ);
  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });

  const invoices = await Promise.all(
    cards.map(async (card) => {
      const dto = cardToDto(card);
      const cycle = getOpenCycle(card, reference.toDate());
      const rangeStart = cycle.cycleStart.startOf('day');
      const rangeEnd = cycle.cycleEnd.endOf('day');
      const purchases = await prisma.expense.findMany({
        where: {
          userId,
          cardId: card.id,
          paymentMethod: 'CREDIT',
          date: { gte: rangeStart.toDate(), lte: rangeEnd.toDate() },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      });
      const payments = await fetchCardPaymentsForCycle(
        userId,
        card.id,
        cycle.cycleEnd.startOf('day').toDate(),
      );

      const invoiceTotalCents = purchases.reduce((sum, purchase) => sum + purchase.amountCents, 0);
      const paidTotalCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const remainingCents = Math.max(0, invoiceTotalCents - paidTotalCents);

      logInvoiceDebug(
        card.id,
        card.closingDay,
        reference.format('YYYY-MM-DD'),
        cycle,
        purchases,
        payments,
        invoiceTotalCents,
        paidTotalCents,
        remainingCents,
      );

      const status =
        invoiceTotalCents === 0
          ? 'EMPTY'
          : remainingCents <= 0
            ? 'PAID'
            : 'OPEN';

      return {
        card: dto,
        cardId: card.id,
        name: dto.name,
        brand: dto.brand,
        closingDay: dto.closingDay,
        dueDay: dto.dueDay,
        closingDate: cycle.cycleEnd.toISOString(),
        dueDate: cycle.dueDate.toISOString(),
        cycleStart: cycle.cycleStart.toISOString(),
        cycleEnd: cycle.cycleEnd.toISOString(),
        invoiceTotal: centsToNumber(invoiceTotalCents),
        paidTotal: centsToNumber(paidTotalCents),
        remaining: centsToNumber(remainingCents),
        status,
      };
    }),
  );

  return res.json({ invoices });
});

router.get('/:cardId/invoices/:cycleEnd', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const parsedCardId =
    typeof req.params.cardId === 'string' ? Number.parseInt(req.params.cardId.trim(), 10) : NaN;
  if (!Number.isInteger(parsedCardId) || parsedCardId <= 0) {
    return res.status(400).json({ error: 'cardId invalido' });
  }

  const rawCycleEnd = typeof req.params.cycleEnd === 'string' ? req.params.cycleEnd.trim() : '';
  if (!rawCycleEnd) {
    return res.status(400).json({ error: 'cycleEnd obrigatorio. Use YYYY-MM-DD.' });
  }

  const parsedCycleEnd = dayjs.tz(rawCycleEnd, 'YYYY-MM-DD', TZ);
  if (!parsedCycleEnd.isValid()) {
    return res.status(400).json({ error: 'cycleEnd invalido. Use YYYY-MM-DD.' });
  }

  const card = await prisma.card.findFirst({
    where: { id: parsedCardId, userId },
  });
  if (!card) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const cycleMonth = parsedCycleEnd.format('YYYY-MM');
  const cycle = getCardCycleForMonth(card, cycleMonth);
  if (!cycle.cycleEnd.isSame(parsedCycleEnd.endOf('day'))) {
    return res.status(400).json({ error: 'cycleEnd invalido para esse cartao' });
  }

  const dueDate = cycle.dueDate;

  const filters: Prisma.ExpenseWhereInput[] = [
    { userId },
    { cardId: card.id },
    { paymentMethod: 'CREDIT' },
    { date: { gte: cycle.cycleStart.toDate(), lte: cycle.cycleEnd.toDate() } },
  ];

  const rawSearch = Array.isArray(req.query.search) ? req.query.search[0] : req.query.search;
  const search = typeof rawSearch === 'string' ? rawSearch.trim() : '';
  if (search) {
    filters.push({ description: { contains: search, mode: 'insensitive' } });
  }

  const rawPage = Array.isArray(req.query.page) ? req.query.page[0] : req.query.page;
  let page = 1;
  if (typeof rawPage !== 'undefined') {
    const parsedPage = Number.parseInt(String(rawPage).trim(), 10);
    if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
      return res.status(400).json({ error: '"page" invalido' });
    }
    page = parsedPage;
  }

  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  let limit = 20;
  if (typeof rawLimit !== 'undefined') {
    const parsedLimit = Number.parseInt(String(rawLimit).trim(), 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: '"limit" invalido' });
    }
    limit = Math.min(parsedLimit, 100);
  }

  const rawSort = Array.isArray(req.query.sort) ? req.query.sort[0] : req.query.sort;
  let sortDirection: 'asc' | 'desc' = 'desc';
  if (typeof rawSort === 'string' && rawSort.trim()) {
    const normalizedSort = rawSort.trim().toLowerCase();
    if (normalizedSort !== 'asc' && normalizedSort !== 'desc') {
      return res.status(400).json({ error: '"sort" deve ser asc ou desc' });
    }
    sortDirection = normalizedSort;
  }

  const whereClause: Prisma.ExpenseWhereInput = { AND: filters };

  const [expenseTotals, purchasesCount, purchases] = await Promise.all([
    prisma.expense.aggregate({
      where: whereClause,
      _sum: { amountCents: true },
    }),
    prisma.expense.count({ where: whereClause }),
    prisma.expense.findMany({
      where: whereClause,
      include: { category: true },
      orderBy: [{ date: sortDirection }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const payments = await fetchCardPaymentsForCycle(
    userId,
    card.id,
    cycle.cycleEnd.startOf('day').toDate(),
  );

  const expenseCents = expenseTotals._sum.amountCents ?? 0;
  const paymentCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const remainingCents = Math.max(0, expenseCents - paymentCents);

  const purchasesList = purchases.map((purchase) => {
    const merchant =
      purchase.purchaseLabel && purchase.purchaseLabel !== purchase.description
        ? purchase.purchaseLabel
        : undefined;
    const hasInstallments =
      purchase.installmentCurrent !== null || purchase.installmentTotal !== null;
    const installmentInfo = hasInstallments
      ? {
          current: purchase.installmentCurrent ?? undefined,
          total: purchase.installmentTotal ?? undefined,
        }
      : undefined;
    return {
      id: purchase.id,
      description: purchase.description,
      amount: centsToNumber(purchase.amountCents),
      date: dayjs(purchase.date).tz(TZ).format('YYYY-MM-DD'),
      category: purchase.category.name,
      merchant,
      installmentInfo,
      createdAt: purchase.createdAt,
    };
  });

  console.log(
    '[cards/invoice-detail] userId=%s cardId=%s cycleEnd=%s page=%s limit=%s sort=%s search=%s',
    userId,
    card.id,
    rawCycleEnd,
    page,
    limit,
    sortDirection,
    search || 'n/a',
  );

  const status =
    expenseCents === 0 ? 'EMPTY' : remainingCents <= 0 ? 'PAID' : 'OPEN';

  return res.json({
    card: cardToDto(card),
    cycleStart: cycle.cycleStart.toISOString(),
    cycleEnd: cycle.cycleEnd.toISOString(),
    closeDate: cycle.cycleEnd.toISOString(),
    dueDate: dueDate.toISOString(),
    invoiceTotal: centsToNumber(expenseCents),
    paidTotal: centsToNumber(paymentCents),
    remaining: centsToNumber(remainingCents),
    status,
    purchases: purchasesList,
    purchasesCount,
  });
});

router.get('/:cardId/invoice', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const parsedCardId =
    typeof req.params.cardId === 'string' ? Number.parseInt(req.params.cardId.trim(), 10) : NaN;
  if (!Number.isInteger(parsedCardId) || parsedCardId <= 0) {
    return res.status(400).json({ error: 'cardId invalido' });
  }

  const rawMonth = Array.isArray(req.query.month) ? req.query.month[0] : req.query.month;
  const parsedMonth = parseMonthParam(rawMonth);
  if (!parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }

  const card = await prisma.card.findFirst({
    where: { id: parsedCardId, userId },
    select: { id: true, name: true, brand: true, closingDay: true, dueDay: true },
  });
  if (!card) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const cycle = getCardCycleForMonth(card, parsedMonth);
  const entries = await prisma.expense.findMany({
    where: {
      userId,
      cardId: card.id,
      paymentMethod: 'CREDIT',
      date: { gte: cycle.cycleStart.toDate(), lte: cycle.cycleEnd.toDate() },
    },
    include: { category: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  const remainingCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  const formattedEntries = entries.map((entry) => {
    const installmentInfo =
      entry.installmentCurrent !== null && entry.installmentTotal !== null
        ? { current: entry.installmentCurrent, total: entry.installmentTotal }
        : undefined;
    return {
      id: entry.id,
      date: dayjs(entry.date).tz(TZ).format('YYYY-MM-DD'),
      description: entry.description,
      amount: centsToNumber(entry.amountCents),
      category: entry.category?.name ?? null,
      paymentMethod: entry.paymentMethod,
      installmentInfo,
    };
  });

  const invoiceStatus = remainingCents > 0 ? 'open' : 'paid';
  return res.json({
    card: {
      id: card.id,
      name: card.name,
      brand: card.brand,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
    },
    month: parsedMonth,
    invoice: {
      status: invoiceStatus,
      remaining: centsToNumber(remainingCents),
      closingDate: cycle.cycleEnd.format('YYYY-MM-DD'),
      dueDate: cycle.dueDate.format('YYYY-MM-DD'),
      cycleStart: cycle.cycleStart.format('YYYY-MM-DD'),
      cycleEnd: cycle.cycleEnd.format('YYYY-MM-DD'),
    },
    entries: formattedEntries,
  });
});

router.get('/:cardId/purchases', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const parsedCardId =
    typeof req.params.cardId === 'string' ? Number.parseInt(req.params.cardId.trim(), 10) : NaN;
  if (!Number.isInteger(parsedCardId) || parsedCardId <= 0) {
    return res.status(400).json({ error: 'cardId invalido' });
  }

  const card = await prisma.card.findFirst({
    where: { id: parsedCardId, userId },
    select: { id: true },
  });
  if (!card) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const range = parseFromToQuery(
    normalizeQueryParam(req.query.from),
    normalizeQueryParam(req.query.to),
  );
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  if (!range.start || !range.endExclusive) {
    return res
      .status(400)
      .json({ error: '"from" e "to" obrigatorios. Use YYYY-MM-DD.' });
  }

  const purchases = await prisma.expense.findMany({
    where: {
      userId,
      cardId: parsedCardId,
      paymentMethod: 'CREDIT',
      date: { gte: range.start, lt: range.endExclusive },
    },
    include: { category: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  const formattedFrom = dayjs(range.start).tz(TZ).format('YYYY-MM-DD');
  const formattedTo = dayjs(range.endExclusive).tz(TZ).subtract(1, 'day').format('YYYY-MM-DD');
  const purchasesDto = purchases.map((purchase) => {
    const hasInstallments =
      purchase.installmentCurrent !== null && purchase.installmentTotal !== null;
    const installmentLabel = hasInstallments
      ? `${purchase.installmentCurrent}/${purchase.installmentTotal}`
      : null;
    return {
      id: purchase.id,
      description: purchase.description,
      amount: centsToNumber(purchase.amountCents),
      date: dayjs(purchase.date).tz(TZ).format('YYYY-MM-DD'),
      category: purchase.category?.name ?? null,
      installmentCurrent: purchase.installmentCurrent ?? null,
      installmentTotal: purchase.installmentTotal ?? null,
      installmentLabel,
      createdAt: purchase.createdAt,
    };
  });

  return res.json({
    cardId: parsedCardId,
    from: formattedFrom,
    to: formattedTo,
    purchases: purchasesDto,
  });
});

router.post('/payments', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const { cardId, amount, paidAt, paymentDate } = req.body ?? {};
  const parsedCardId =
    typeof cardId === 'number'
      ? cardId
      : typeof cardId === 'string'
        ? Number.parseInt(cardId.trim(), 10)
        : NaN;
  if (!Number.isInteger(parsedCardId) || parsedCardId <= 0) {
    return res.status(400).json({ error: '"cardId" invalido' });
  }

  const card = await prisma.card.findFirst({
    where: { id: parsedCardId, userId },
    select: { id: true, closingDay: true, dueDay: true },
  });
  if (!card) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const amountCents = toAmountCents(amount);
  if (!amountCents || amountCents <= 0) {
    return res.status(400).json({ error: 'amount deve ser maior que zero' });
  }

  const rawPaidAt =
    typeof paidAt === 'string' && paidAt.trim()
      ? paidAt.trim()
      : typeof paymentDate === 'string' && paymentDate.trim()
        ? paymentDate.trim()
        : undefined;
  const parsedPaidAt = rawPaidAt ? dayjs.tz(rawPaidAt, 'YYYY-MM-DD', TZ) : nowBahia().tz(TZ);
  if (!parsedPaidAt.isValid()) {
    return res.status(400).json({ error: '"paidAt" invalido. Use YYYY-MM-DD.' });
  }
  const resolvedDate = parsedPaidAt.startOf('day');

  const cycle = getOpenCycle(card, resolvedDate.toDate());
  const cycleStart = cycle.cycleStart.startOf('day');
  const cycleEnd = cycle.cycleEnd.startOf('day');

  const payment = await prisma.cardPayment.create({
    data: {
      userId,
      cardId: card.id,
      amountCents,
      paymentDate: resolvedDate.toDate(),
      cycleEnd: cycleEnd.toDate(),
    },
  });

  console.log('[cards/payments] created', {
    id: payment.id,
    userId,
    cardId: card.id,
    amountCents: payment.amountCents,
    paidAt: dayjs(payment.paymentDate).tz(TZ).format('YYYY-MM-DD'),
    cycleEnd: dayjs(payment.cycleEnd).tz(TZ).format('YYYY-MM-DD'),
  });

  return res.status(201).json({
    id: payment.id,
    cardId: payment.cardId,
    amount: centsToNumber(payment.amountCents),
    paymentDate: dayjs(payment.paymentDate).tz(TZ).format('YYYY-MM-DD'),
    paidAt: dayjs(payment.paymentDate).tz(TZ).format('YYYY-MM-DD'),
    cycleEnd: dayjs(payment.cycleEnd).tz(TZ).format('YYYY-MM-DD'),
    cycleStart: cycle.cycleStart.format('YYYY-MM-DD'),
    createdAt: payment.createdAt,
  });
});

// GET /api/cards -> lista CardDTO completo (inclui brand/color/limit/closingDay/dueDay). Exemplo: [{ id:1, name:'Visa', brand:'VISA', color:'#4F46E5', limit:5000, closingDay:5, dueDay:20, createdAt:'2026-01-12T16:00:00Z', updatedAt:'2026-01-12T16:00:00Z' }]
router.get('/', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const cardDtos = cards.map(cardToDto);
  logCardDebug('/api/cards', cardDtos);
  return res.json({ items: cardDtos, cards: cardDtos });
});

router.post('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[cards][post] userId=%s', userId);
  console.log('[cards][post] userId=%s body=%o', userId, req.body ?? {});

  const { name, brand, limit, closingDay, dueDay, color, textColor } = req.body ?? {};
  const errors: { field: string; message: string }[] = [];

  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!normalizedName) {
    errors.push({ field: 'name', message: 'name obrigatorio' });
  }

  const normalizedBrand = normalizeBrand(brand);
  if (!normalizedBrand) {
    errors.push({ field: 'brand', message: 'brand invalido' });
  }

  const closing = parseDay(closingDay);
  if (!closing) {
    errors.push({ field: 'closingDay', message: 'closingDay invalido (1-31)' });
  }

  const due = parseDay(dueDay);
  if (!due) {
    errors.push({ field: 'dueDay', message: 'dueDay invalido (1-31)' });
  }

  const limitCents = parseLimit(limit);
  if (limitCents === null) {
    errors.push({ field: 'limit', message: 'limit invalido' });
  }

  let normalizedColor = DEFAULT_CARD_COLOR;
  if (typeof color !== 'undefined') {
    const parsedColor = parseHexColor(color);
    if (!parsedColor) {
      errors.push({ field: 'color', message: 'color invalido (hex)' });
    } else {
      normalizedColor = parsedColor;
    }
  }

  let normalizedTextColor: string | null = null;
  if (typeof textColor !== 'undefined') {
    const parsedTextColor = parseHexColor(textColor);
    if (!parsedTextColor) {
      errors.push({ field: 'textColor', message: 'textColor invalido (hex)' });
    } else {
      normalizedTextColor = parsedTextColor;
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: 'ValidationError', fields: errors });
  }

  try {
    const card = await prisma.card.create({
      data: {
        userId,
        name: normalizedName,
        brand: normalizedBrand!,
        limit: limitCents!,
        closingDay: closing!,
        dueDay: due!,
        color: normalizedColor,
        textColor: normalizedTextColor,
      },
    });

    const dto = cardToDto(card);
    logCardDebug('/api/cards', [dto]);
    return res.status(201).json(dto);
  } catch (err) {
    console.error('[cards][post] erro ao salvar cartao', err);
    const message = err instanceof Error ? err.message : 'Erro ao salvar cartao';
    return res.status(500).json({ error: message });
  }
});

router.put('/:id', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  const { name, brand, limit, closingDay, dueDay, color, textColor } = req.body ?? {};
  if (
    typeof name === 'undefined' &&
    typeof brand === 'undefined' &&
    typeof limit === 'undefined' &&
    typeof closingDay === 'undefined' &&
    typeof dueDay === 'undefined' &&
    typeof color === 'undefined' &&
    typeof textColor === 'undefined'
  ) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  const data: {
    name?: string;
    brand?: string;
    limit?: number;
    closingDay?: number;
    dueDay?: number;
    color?: string;
    textColor?: string | null;
  } = {};

  if (typeof name !== 'undefined') {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name obrigatorio' });
    }
    data.name = name.trim();
  }

  if (typeof brand !== 'undefined') {
    const normalizedBrand = normalizeBrand(brand);
    if (!normalizedBrand) {
      return res.status(400).json({ error: 'brand invalido' });
    }
    data.brand = normalizedBrand;
  }

  if (typeof closingDay !== 'undefined') {
    const closing = parseDay(closingDay);
    if (!closing) {
      return res.status(400).json({ error: 'closingDay invalido (1-31)' });
    }
    data.closingDay = closing;
  }

  if (typeof dueDay !== 'undefined') {
    const due = parseDay(dueDay);
    if (!due) {
      return res.status(400).json({ error: 'dueDay invalido (1-31)' });
    }
    data.dueDay = due;
  }

  if (typeof limit !== 'undefined') {
    const limitCents = parseLimit(limit);
    if (limitCents === null) {
      return res.status(400).json({ error: 'limit invalido' });
    }
    data.limit = limitCents;
  }

  if (typeof color !== 'undefined') {
    const parsedColor = parseHexColor(color);
    if (!parsedColor) {
      return res.status(400).json({ error: 'color invalido (hex)' });
    }
    data.color = parsedColor;
  }

  if (typeof textColor !== 'undefined') {
    const parsedTextColor = parseHexColor(textColor);
    if (!parsedTextColor) {
      return res.status(400).json({ error: 'textColor invalido (hex)' });
    }
    data.textColor = parsedTextColor;
  }

  const updated = await prisma.card.updateMany({
    where: { id, userId },
    data,
  });

  if (!updated.count) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const saved = await prisma.card.findFirst({ where: { id, userId } });
  if (!saved) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  const dto = cardToDto(saved);
  logCardDebug('/api/cards', [dto]);
  return res.json(dto);
});

router.delete('/:id', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  const deleted = await prisma.card.deleteMany({ where: { id, userId } });
  if (!deleted.count) {
    return res.status(404).json({ error: 'Cartao nao encontrado' });
  }

  return res.status(204).send();
});

export default router;
