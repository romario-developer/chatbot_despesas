import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { nowBahia, TZ } from '../../utils/dates';
import { centsToNumber, toAmountCents } from '../../utils/money';
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

router.get('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[cards][get] userId=%s', userId);

  const cards = await prisma.card.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ items: cards.map(mapCard) });
});

router.post('/', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
