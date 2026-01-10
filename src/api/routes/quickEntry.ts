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
import { inferCategory } from '../../domain/categorizer';
import { DEFAULT_PAYMENT_METHOD } from '../../utils/paymentMethod';
import type { AuthedRequest } from '../middleware/auth';

const router = Router();

type CategoryMatch = {
  name: string;
  normalizedName: string;
};

const CARD_SELECT = { id: true, name: true, brand: true, color: true } as const;

type CardSummary = {
  id: number;
  name: string;
  brand: string;
  color: string;
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
  paymentMethod: string;
  cardId: number | null;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
  card?: CardSummary | null;
}) {
  const amountCents = assertValidAmountCents(expense.amountCents, 'expense.amountCents', { allowZero: true });
  const date = dayjs(expense.date).tz(TZ);
  return {
    id: expense.id,
    amount: centsToNumber(amountCents),
    paymentMethod: expense.paymentMethod,
    cardId: expense.cardId ?? null,
    card: expense.card ? { id: expense.card.id, name: expense.card.name, brand: expense.card.brand, color: expense.card.color } : null,
    description: expense.description,
    category: expense.category.name,
    date: date.format('YYYY-MM-DD'),
    month: date.format('YYYY-MM'),
    source: expense.source,
    rawText: expense.rawText,
    createdAt: expense.createdAt,
  };
}

function normalizeTextForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCardMatch(rawText: string, cards: CardSummary[]) {
  const normalizedText = normalizeTextForMatch(rawText);
  if (!normalizedText) return null;

  const haystack = ` ${normalizedText} `;
  const candidates = cards
    .map((card) => ({ card, normalizedName: normalizeTextForMatch(card.name) }))
    .filter((item) => item.normalizedName)
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length);

  for (const item of candidates) {
    if (haystack.includes(` ${item.normalizedName} `)) {
      return item.card;
    }
  }

  return null;
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
  if (rawText.length > 200) {
    return res.status(400).json({ error: '"text" deve ter no maximo 200 caracteres' });
  }

  await ensureDefaultCategory(user.id);
  const categories = await listCategories(user.id);
  const baseCategoryResolver = buildPrefixCategoryResolver(
    categories.map((category) => ({
      name: category.name,
      normalizedName: category.normalizedName,
    })),
  );
  let hasExplicitCategory = false;
  const categoryResolver: CategoryResolver = (text: string) => {
    const resolved = baseCategoryResolver(text);
    if (resolved?.categoryName) {
      hasExplicitCategory = true;
    }
    return resolved;
  };

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

  let categoryName = parsed.categoryName || 'Outros';
  let categoryInferred = false;
  let categoryConfidence = 0;

  if (!hasExplicitCategory) {
    const inference = inferCategory(parsed.description);
    categoryConfidence = inference.confidence;
    if (inference.categoryName && inference.confidence >= 0.6) {
      categoryName = inference.categoryName;
      categoryInferred = true;
    }
  }

  const category = await getOrCreateCategory(user.id, categoryName || 'Outros');
  const cards = await prisma.card.findMany({ where: { userId: user.id }, select: CARD_SELECT });
  const matchedCard = cards.length ? findCardMatch(parsed.rawText, cards) : null;

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents,
      paymentMethod: DEFAULT_PAYMENT_METHOD,
      cardId: matchedCard?.id ?? null,
      description: parsed.description || 'Sem descricao',
      date: parsed.date,
      source: 'pwa-quick',
      rawText: parsed.rawText,
    },
    include: { category: true, card: { select: CARD_SELECT } },
  });

  console.info(`[quick-entry] userId=${user.id} amountCents=${amountCents}`);

  const entry = mapExpense(expense);

  return res.status(201).json({
    ...entry,
    entry,
    categoryInferred,
    categoryConfidence,
    parsed: {
      description: parsed.description,
      amount: entry.amount,
      amountCents,
      categoryName: category.name,
      date: parsed.dateKey,
    },
  });
});

export default router;
