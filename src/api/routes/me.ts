import { Router } from 'express';

import { prisma } from '../../infra/db/prisma';
import { getPlanningByUserId, upsertPlanning } from '../../services/planningService';
import { normalizeCategoryName } from '../../utils/normalize';
import { dayjs, TZ } from '../../utils/dates';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

const SAMPLE_SOURCE = 'sample';
const SAMPLE_EXTRA_ID = 'sample-income';

router.post('/sample-data', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const userId = req.user.id;
    const existingSample = await prisma.expense.count({
      where: { userId, source: SAMPLE_SOURCE },
    });

    if (existingSample > 0) {
      return res.json({
        created: { categories: 0, expenses: 0, planning: 0 },
        skipped: true,
      });
    }

    const sampleCategories = [
      { name: 'Alimentacao', normalizedName: normalizeCategoryName('Alimentacao') },
      { name: 'Transporte', normalizedName: normalizeCategoryName('Transporte') },
    ];

    const createdCategories = await prisma.category.createMany({
      data: sampleCategories.map((cat) => ({
        userId,
        name: cat.name,
        normalizedName: cat.normalizedName,
      })),
      skipDuplicates: true,
    });

    const categoryRows = await prisma.category.findMany({
      where: {
        userId,
        normalizedName: { in: sampleCategories.map((cat) => cat.normalizedName) },
      },
    });

    const categoryMap = new Map(categoryRows.map((cat) => [cat.normalizedName, cat.id]));
    const foodId = categoryMap.get(sampleCategories[0].normalizedName);
    const transportId = categoryMap.get(sampleCategories[1].normalizedName);

    if (!foodId || !transportId) {
      return res.status(500).json({ error: 'Falha ao preparar categorias de exemplo' });
    }

    const today = dayjs.tz().startOf('day');
    const expensesData = [
      {
        userId,
        categoryId: foodId,
        amountCents: 12500,
        description: 'Mercado',
        date: today.toDate(),
        rawText: 'Mercado',
        source: SAMPLE_SOURCE,
      },
      {
        userId,
        categoryId: foodId,
        amountCents: 3590,
        description: 'Almoco',
        date: today.subtract(1, 'day').toDate(),
        rawText: 'Almoco',
        source: SAMPLE_SOURCE,
      },
      {
        userId,
        categoryId: transportId,
        amountCents: 7800,
        description: 'Combustivel',
        date: today.subtract(3, 'day').toDate(),
        rawText: 'Combustivel',
        source: SAMPLE_SOURCE,
      },
    ];

    const createdExpenses = await prisma.expense.createMany({
      data: expensesData,
    });

    const monthKey = dayjs.tz(TZ).format('YYYY-MM');
    const planning = await getPlanningByUserId(userId);
    const monthExtras = [...(planning.extrasByMonth[monthKey] ?? [])];
    let planningCreated = 0;

    if (!monthExtras.some((item) => item.id === SAMPLE_EXTRA_ID)) {
      monthExtras.push({
        id: SAMPLE_EXTRA_ID,
        label: 'Receita de exemplo',
        amount: 2500,
      });
      const updated = {
        ...planning,
        extrasByMonth: { ...planning.extrasByMonth, [monthKey]: monthExtras },
      };
      await upsertPlanning(userId, updated);
      planningCreated = 1;
    }

    return res.json({
      created: {
        categories: createdCategories.count,
        expenses: createdExpenses.count,
        planning: planningCreated,
      },
      skipped: false,
    });
  } catch (err) {
    console.error('[me][sample-data] erro:', err);
    return res.status(500).json({ error: 'Falha ao criar dados de exemplo' });
  }
});

export default router;
