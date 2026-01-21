import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { centsToNumber, toAmountCents } from '../../utils/money';
import { dayjs, nowBahia, TZ } from '../../utils/dates';
import { getMonthRangeFromMonthYear } from '../../utils/dateRange';
import type { AuthedRequest } from '../middleware/auth';

const router = Router();

function parseLimit(value: unknown): number | null {
  const cents = toAmountCents(value);
  if (cents === null) return null;
  return cents >= 0 ? cents : null;
}

function mapCredit(credit: {
  id: number;
  userId: number;
  amountCents: number;
  description: string;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: credit.id,
    userId: credit.userId,
    amount: centsToNumber(credit.amountCents),
    amountCents: credit.amountCents,
    description: credit.description,
    source: credit.source,
    createdAt: credit.createdAt,
    updatedAt: credit.updatedAt,
  };
}

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  return null;
}

function parseMonthParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

// GET /credits - List all credits for the user
router.get('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const credits = await prisma.credit.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    const items = credits.map(mapCredit);
    return res.json({ items });
  } catch (error) {
    console.error('[credits] error listing credits', error);
    return res.status(500).json({ error: 'Erro ao listar créditos' });
  }
});

router.get('/overview', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const providedMonth = typeof req.query.month !== 'undefined';
  const parsedMonth = parseMonthParam(req.query.month);
  if (providedMonth && !parsedMonth) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }

  const month = parsedMonth ?? nowBahia().format('YYYY-MM');
  const parsed = dayjs.tz(`${month}-01`, 'YYYY-MM-DD', TZ);
  if (!parsed.isValid()) {
    return res.status(400).json({ error: 'Parametro "month" invalido. Use YYYY-MM.' });
  }

  const { start, endExclusive } = getMonthRangeFromMonthYear(parsed.month() + 1, parsed.year(), TZ);

  try {
    const credits = await prisma.credit.findMany({
      where: {
        userId: user.id,
        createdAt: {
          gte: start,
          lt: endExclusive,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalAmountCents = credits.reduce((sum, credit) => sum + credit.amountCents, 0);
    const totalAmount = centsToNumber(totalAmountCents);
    const averageAmount =
      credits.length > 0 ? centsToNumber(Math.round(totalAmountCents / credits.length)) : 0;

    const bySourceMap = new Map<string | null, { source: string | null; totalCents: number; count: number }>();
    for (const credit of credits) {
      const key = credit.source ?? null;
      const existing = bySourceMap.get(key);
      if (existing) {
        existing.totalCents += credit.amountCents;
        existing.count += 1;
      } else {
        bySourceMap.set(key, {
          source: credit.source,
          totalCents: credit.amountCents,
          count: 1,
        });
      }
    }

    const bySource = Array.from(bySourceMap.values())
      .map((entry) => ({
        source: entry.source,
        totalAmount: centsToNumber(entry.totalCents),
        count: entry.count,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);

    return res.json({
      month,
      totalAmount,
      totalAmountCents,
      averageAmount,
      creditCount: credits.length,
      bySource,
      items: credits.map(mapCredit),
    });
  } catch (error) {
    console.error('[credits] error fetching overview', error);
    return res.status(500).json({ error: 'Erro ao carregar o panorama de creditos' });
  }
});

// GET /credits/:id - Get a specific credit
router.get('/:id', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  try {
    const credit = await prisma.credit.findUnique({
      where: { id },
    });

    if (!credit) {
      return res.status(404).json({ error: 'Crédito não encontrado' });
    }

    if (credit.userId !== user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    return res.json({ credit: mapCredit(credit) });
  } catch (error) {
    console.error('[credits] error fetching credit', error);
    return res.status(500).json({ error: 'Erro ao buscar crédito' });
  }
});

// POST /credits - Create a new credit
router.post('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (!description || description.length < 1) {
    return res.status(400).json({ error: 'Descrição é obrigatória' });
  }

  const amountCents = parseLimit(req.body?.amount);
  if (amountCents === null || amountCents <= 0) {
    return res.status(400).json({ error: 'Valor inválido' });
  }

  const source = typeof req.body?.source === 'string' ? req.body.source.trim() : null;

  try {
    const credit = await prisma.credit.create({
      data: {
        userId: user.id,
        amountCents,
        description,
        source: source || null,
      },
    });

    return res.status(201).json({ credit: mapCredit(credit) });
  } catch (error) {
    console.error('[credits] error creating credit', error);
    return res.status(500).json({ error: 'Erro ao criar crédito' });
  }
});

// PATCH /credits/:id - Update a credit
router.patch('/:id', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  try {
    const credit = await prisma.credit.findUnique({
      where: { id },
    });

    if (!credit) {
      return res.status(404).json({ error: 'Crédito não encontrado' });
    }

    if (credit.userId !== user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const updates: { amountCents?: number; description?: string; source?: string | null } = {};

    if (typeof req.body?.amount !== 'undefined') {
      const amountCents = parseLimit(req.body.amount);
      if (amountCents === null || amountCents <= 0) {
        return res.status(400).json({ error: 'Valor inválido' });
      }
      updates.amountCents = amountCents;
    }

    if (typeof req.body?.description === 'string') {
      const description = req.body.description.trim();
      if (description.length < 1) {
        return res.status(400).json({ error: 'Descrição não pode estar vazia' });
      }
      updates.description = description;
    }

    if (typeof req.body?.source === 'string') {
      updates.source = req.body.source.trim() || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    const updatedCredit = await prisma.credit.update({
      where: { id },
      data: updates,
    });

    return res.json({ credit: mapCredit(updatedCredit) });
  } catch (error) {
    console.error('[credits] error updating credit', error);
    return res.status(500).json({ error: 'Erro ao atualizar crédito' });
  }
});

// DELETE /credits/:id - Delete a credit
router.delete('/:id', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  try {
    const credit = await prisma.credit.findUnique({
      where: { id },
    });

    if (!credit) {
      return res.status(404).json({ error: 'Crédito não encontrado' });
    }

    if (credit.userId !== user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await prisma.credit.delete({
      where: { id },
    });

    return res.status(204).send();
  } catch (error) {
    console.error('[credits] error deleting credit', error);
    return res.status(500).json({ error: 'Erro ao deletar crédito' });
  }
});

export default router;
