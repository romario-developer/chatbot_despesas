import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { dayjs, nowBahia, TZ } from '../../utils/dates';
import { centsToNumber, toAmountCents } from '../../utils/money';
import { cardToDto, InvoiceViewDto, logCardDebug } from '../../utils/cardDto';
import { Prisma } from '@prisma/client';
import { getCardCycleRange } from '../../domain/cardCycle';
import type { AuthedRequest } from '../middleware/auth';
import type { Dayjs } from 'dayjs';

const router = Router();

const BRAND_VALUES = new Set(['VISA', 'MASTERCARD', 'ELO', 'AMEX', 'OTHER']);
const DEFAULT_CARD_COLOR = '#4F46E5';

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

function clampDay(value: number): number {
  if (!Number.isInteger(value)) {
    return 1;
  }
  return Math.min(Math.max(value, 1), 31);
}

type DayjsCycleRange = {
  start: Dayjs;
  end: Dayjs;
};

function buildMonthClosingDate(base: Dayjs, closingDay: number) {
  const monthDays = base.endOf('month').date();
  const day = Math.min(clampDay(closingDay), monthDays);
  return base.date(day).endOf('day');
}

function buildCycleForClosingMonth(month: string, closingDay: number): DayjsCycleRange {
  const currentMonth = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
  const previousMonth = currentMonth.subtract(1, 'month');
  const currentClosing = buildMonthClosingDate(currentMonth, closingDay);
  const previousClosing = buildMonthClosingDate(previousMonth, closingDay);
  const start = previousClosing.add(1, 'millisecond').startOf('day');
  return { start, end: currentClosing };
}

function buildCycleFromReference(reference: Dayjs, closingDay: number): DayjsCycleRange {
  const cycle = getCardCycleRange(reference.toDate(), closingDay);
  return {
    start: dayjs.tz(cycle.startDate, 'YYYY-MM-DD', TZ).startOf('day'),
    end: dayjs.tz(cycle.endDate, 'YYYY-MM-DD', TZ).endOf('day'),
  };
}

// dueDay < closingDay typically moves the due date to the month after closing, otherwise stays in the closing month.
function resolveDueDate(cycleEnd: Dayjs, dueDay: number, closingDay: number): Dayjs {
  const normalizedDue = clampDay(dueDay);
  const normalizedClosing = clampDay(closingDay);
  let candidate = cycleEnd.clone();
  if (normalizedDue < normalizedClosing) {
    candidate = candidate.add(1, 'month');
  }
  const monthDays = candidate.endOf('month').date();
  const day = Math.min(normalizedDue, monthDays);
  return candidate.date(day).startOf('day');
}

async function sumCardPayments(userId: number, cardId: number, cycleEndStart: Date) {
  try {
    return await prisma.cardPayment.aggregate({
      where: {
        userId,
        cardId,
        cycleEnd: cycleEndStart,
      },
      _sum: { amountCents: true },
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
      return { _sum: { amountCents: 0 } };
    }
    throw err;
  }
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
      const cycleRange = parsedMonth
        ? buildCycleForClosingMonth(parsedMonth, card.closingDay)
        : buildCycleFromReference(asOf, card.closingDay);
      const cycleStart = cycleRange.start;
      const cycleEnd = cycleRange.end;
      const cycleEndStart = cycleEnd.startOf('day');
      const dueDate = resolveDueDate(cycleEnd, card.dueDay, card.closingDay);

      const expenseTotals = await prisma.expense.aggregate({
        where: {
          userId,
          cardId: card.id,
          paymentMethod: 'CREDIT',
          date: { gte: cycleStart.toDate(), lte: cycleEnd.toDate() },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      });

      const paymentTotals = await sumCardPayments(userId, card.id, cycleEndStart.toDate());
      const expenseCents = expenseTotals._sum.amountCents ?? 0;
      const paymentCents = paymentTotals._sum.amountCents ?? 0;
      const remainingCents = Math.max(0, expenseCents - paymentCents);
      const invoiceTotal = centsToNumber(expenseCents);
      const paidTotal = centsToNumber(paymentCents);
      const remaining = centsToNumber(remainingCents);

      const status = remaining > 0 ? 'OPEN' : 'PAID';

      return {
        cardId: card.id,
        ...dto,
        card: dto,
        cycleStart: cycleStart.toISOString(),
        cycleEnd: cycleEnd.toISOString(),
        dueDate: dueDate.toISOString(),
        entriesCount: expenseTotals._count._all ?? 0,
        invoiceTotal,
        paidTotal,
        remaining,
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
      const cycleRange = buildCycleFromReference(reference, card.closingDay);
      const cycleStart = cycleRange.start;
      const cycleEnd = cycleRange.end;
      const cycleEndStart = cycleEnd.clone().startOf('day');

      const expenseTotals = await prisma.expense.aggregate({
        where: {
          userId,
          cardId: card.id,
          paymentMethod: 'CREDIT',
          date: { gte: cycleStart.toDate(), lte: cycleEnd.toDate() },
        },
        _sum: { amountCents: true },
      });

      const paymentTotals = await sumCardPayments(
        userId,
        card.id,
        cycleEndStart.toDate(),
      );

      const expenseCents = expenseTotals._sum.amountCents ?? 0;
      const paymentCents = paymentTotals._sum.amountCents ?? 0;
      const remainingCents = Math.max(0, expenseCents - paymentCents);

      return {
        card: dto,
        cycleStart: cycleStart.toISOString(),
        cycleEnd: cycleEnd.toISOString(),
        invoiceTotal: centsToNumber(expenseCents),
        paidTotal: centsToNumber(paymentCents),
        remaining: centsToNumber(remainingCents),
        status: remainingCents > 0 ? 'OPEN' : 'PAID',
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
  const cycleRange = buildCycleForClosingMonth(cycleMonth, card.closingDay);
  if (!cycleRange.end.isSame(parsedCycleEnd.endOf('day'))) {
    return res.status(400).json({ error: 'cycleEnd invalido para esse cartao' });
  }

  const dueDate = resolveDueDate(cycleRange.end, card.dueDay, card.closingDay);

  const filters: Prisma.ExpenseWhereInput[] = [
    { userId },
    { cardId: card.id },
    { paymentMethod: 'CREDIT' },
    { date: { gte: cycleRange.start.toDate(), lte: cycleRange.end.toDate() } },
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

  const paymentTotals = await sumCardPayments(
    userId,
    card.id,
    cycleRange.end.startOf('day').toDate(),
  );

  const expenseCents = expenseTotals._sum.amountCents ?? 0;
  const paymentCents = paymentTotals._sum.amountCents ?? 0;
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

  return res.json({
    card: cardToDto(card),
    cycleStart: cycleRange.start.toISOString(),
    cycleEnd: cycleRange.end.toISOString(),
    closeDate: cycleRange.end.toISOString(),
    dueDate: dueDate.toISOString(),
    invoiceTotal: centsToNumber(expenseCents),
    paidTotal: centsToNumber(paymentCents),
    remaining: centsToNumber(remainingCents),
    status: remainingCents > 0 ? 'OPEN' : 'PAID',
    purchases: purchasesList,
    purchasesCount,
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
    select: { id: true, closingDay: true },
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

  const cycle = getCardCycleRange(resolvedDate.toDate(), card.closingDay);
  const cycleStart = dayjs.tz(cycle.startDate, 'YYYY-MM-DD', TZ).startOf('day');
  const cycleEnd = dayjs.tz(cycle.endDate, 'YYYY-MM-DD', TZ).startOf('day');

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
    cycleStart: cycle.startDate,
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
