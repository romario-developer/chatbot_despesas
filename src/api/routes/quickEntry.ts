import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory, listCategories } from '../../services/categoryService';
import {
  parseQuickEntryText,
  QuickEntryParseError,
  type CategoryResolver,
} from '../../domain/quickEntry/parseQuickEntry';
import { assertValidAmountCents, centsToNumber } from '../../utils/money';
import { dayjs, TZ } from '../../utils/dates';
import { normalizeCategoryName } from '../../utils/normalize';
import type { AuthedRequest } from '../middleware/auth';

const router = Router();

type CategoryMatch = {
  name: string;
  normalizedName: string;
};

function buildPrefixCategoryResolver(categories: CategoryMatch[]): CategoryResolver {
  const normalized = categories
    .map((category) => ({
      name: category.name,
      normalizedName: category.normalizedName || normalizeCategoryName(category.name),
    }))
    .filter((category) => category.normalizedName)
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length);

  return (text: string) => {
    const normalizedText = normalizeCategoryName(text);
    for (const category of normalized) {
      if (!normalizedText.startsWith(category.normalizedName)) continue;
      const nextChar = normalizedText.slice(
        category.normalizedName.length,
        category.normalizedName.length + 1,
      );
      if (nextChar && /[\p{L}\p{N}]/u.test(nextChar)) continue;
      return { categoryName: category.name, cleanedText: text };
    }
    return null;
  };
}

function mapExpense(expense: {
  id: number;
  amountCents: number;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
}) {
  const amountCents = assertValidAmountCents(expense.amountCents, 'expense.amountCents', { allowZero: true });
  return {
    id: expense.id,
    amount: centsToNumber(amountCents),
    description: expense.description,
    category: expense.category.name,
    date: dayjs(expense.date).tz(TZ).format('YYYY-MM-DD'),
    source: expense.source,
    rawText: expense.rawText,
    createdAt: expense.createdAt,
  };
}

router.post('/', async (req: AuthedRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!rawText) {
    return res.status(400).json({ error: '"text" obrigatorio' });
  }
  if (rawText.length < 3 || rawText.length > 200) {
    return res.status(400).json({ error: '"text" deve ter entre 3 e 200 caracteres' });
  }

  await ensureDefaultCategory(user.id);
  const categories = await listCategories(user.id);
  const categoryResolver = buildPrefixCategoryResolver(
    categories.map((category) => ({
      name: category.name,
      normalizedName: category.normalizedName,
    })),
  );

  let parsed;
  try {
    // Use the last numeric value to align with quick entry input (ex: "gasolina 20 hoje 35").
    parsed = parseQuickEntryText(rawText, {
      amountMatchStrategy: 'last',
      categoryResolver,
      defaultCategoryName: 'Outros',
      defaultDescription: 'Sem descricao',
      messages: {
        missingAmount: 'Informe um valor. Ex: mercado 50',
        invalidAmount: 'Valor invalido. Use 40 ou 40,50.',
      },
    });
  } catch (err) {
    if (err instanceof QuickEntryParseError && err.code === 'missing_amount') {
      return res.status(422).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : 'Nao consegui interpretar o texto.';
    return res.status(400).json({ error: message });
  }

  let amountCents: number;
  try {
    amountCents = assertValidAmountCents(parsed.amountCents, 'amountCents');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Valor invalido.';
    return res.status(422).json({ error: message });
  }

  const category = await getOrCreateCategory(user.id, parsed.categoryName || 'Outros');

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents,
      description: parsed.description || 'Sem descricao',
      date: parsed.date,
      source: 'pwa-quick',
      rawText: parsed.rawText,
    },
    include: { category: true },
  });

  console.info(`[quick-entry] userId=${user.id} amountCents=${amountCents}`);

  return res.status(201).json({
    entry: mapExpense(expense),
    parsed: {
      description: parsed.description,
      amountCents,
      categoryName: category.name,
      date: dayjs(parsed.date).tz(TZ).format('YYYY-MM-DD'),
    },
  });
});

export default router;
