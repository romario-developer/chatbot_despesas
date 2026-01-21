import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { dayjs, nowBahia, TZ } from '../../utils/dates';
import { centsToNumber, toAmountCents } from '../../utils/money';
import { Prisma } from '@prisma/client';
import { getCardCycleRange } from '../../domain/cardCycle';
import type { AuthedRequest } from '../middleware/auth';

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

function mapCard(card: {
  id: number;
  userId: number;
  name: string;
  brand: string;
  limit: number;
  closingDay: number;
  dueDay: number;
  color: string;
  textColor: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: card.id,
    userId: card.userId,
    name: card.name,
    brand: card.brand,
    limit: centsToNumber(card.limit),
    closingDay: card.closingDay,
    dueDay: card.dueDay,
    color: card.color,
    textColor: card.textColor,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
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

  const items = cards.map((card) => ({
    cardId: card.id,
    name: card.name,
    brand: card.brand,
    limit: centsToNumber(card.limit),
    closingDay: card.closingDay,
    dueDay: card.dueDay,
    spentInMonth: 0,
  }));

  return res.json({ month, items });
});

router.get('/invoices', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const rawAsOf = Array.isArray(req.query.asOf) ? req.query.asOf[0] : req.query.asOf;
  const asOfString = typeof rawAsOf === 'string' ? rawAsOf.trim() : undefined;
  const asOfCandidate = asOfString ? dayjs.tz(asOfString, 'YYYY-MM-DD', TZ) : undefined;
  const asOfBase = asOfCandidate ?? nowBahia().tz(TZ);
  if (asOfString && (!asOfCandidate || !asOfCandidate.isValid())) {
    return res.status(400).json({ error: 'Parametro "asOf" invalido. Use YYYY-MM-DD.' });
  }
  const asOf = asOfBase.startOf('day');

  console.log('[cards/invoices] userId=%s asOf=%s', userId, asOf.format('YYYY-MM-DD'));

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });

  async function sumCardPayments(cardId: number, cycleEndStart: Date) {
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

  const invoices = await Promise.all(
    cards.map(async (card) => {
      const cycle = getCardCycleRange(asOf.toDate(), card.closingDay);
      const cycleStart = dayjs.tz(cycle.startDate, 'YYYY-MM-DD', TZ).startOf('day');
      const cycleEndDay = dayjs.tz(cycle.endDate, 'YYYY-MM-DD', TZ).endOf('day');
      const cycleEndStart = cycleEndDay.startOf('day');

      const expenseTotals = await prisma.expense.aggregate({
        where: {
          userId,
          cardId: card.id,
          paymentMethod: 'CREDIT',
          date: { gte: cycleStart.toDate(), lte: cycleEndDay.toDate() },
        },
        _sum: { amountCents: true },
        _count: { _all: true },
      });

      const paymentTotals = await sumCardPayments(card.id, cycleEndStart.toDate());
      const expenseCents = expenseTotals._sum.amountCents ?? 0;
      const paymentCents = paymentTotals._sum.amountCents ?? 0;
      const remainingCents = Math.max(0, expenseCents - paymentCents);
      const invoiceTotal = centsToNumber(expenseCents);
      const paidTotal = centsToNumber(paymentCents);
      const remaining = centsToNumber(remainingCents);

      const status =
        invoiceTotal > 0 && remaining === 0
          ? 'PAGA'
          : asOf.isAfter(cycleEndDay)
          ? 'FECHADA'
          : 'ABERTA';
      // status: PAGA quando remaining == 0 e invoiceTotal > 0; FECHADA quando passou do ciclo e ainda existe pendência; caso contrário ABERTA.

      return {
        cardId: card.id,
        name: card.name,
        brand: card.brand,
        color: card.color,
        closingDay: card.closingDay,
        dueDay: card.dueDay,
        cycleStart: cycle.startDate,
        cycleEnd: cycle.endDate,
        invoiceTotal,
        entriesCount: expenseTotals._count._all ?? 0,
        paidTotal,
        remaining,
        status,
      };
    }),
  );

  return res.json({ asOf: asOf.format('YYYY-MM-DD'), invoices });
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

router.get('/', async (req: AuthedRequest, res) => {
  if (!req.user || !Number.isInteger(req.user.id)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.id;

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const mapped = cards.map(mapCard);
  return res.json({ items: mapped, cards: mapped });
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

    return res.status(201).json(mapCard(card));
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

  return res.json(mapCard(saved));
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
