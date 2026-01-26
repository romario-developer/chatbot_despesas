import { Router } from 'express';

import { prisma } from '../../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory, listCategories } from '../../services/categoryService';
import {
  parseQuickEntryText,
  QuickEntryParseError,
  type CategoryResolver,
} from '../../domain/quickEntry/parseQuickEntry';
import { parseInstallments } from '../../domain/quickEntryInstallments';
import { parseInstallmentPattern } from '../../domain/installmentPattern';
import { parsePayment } from '../../domain/quickEntryPayment';
import { assertValidAmountCents, centsToNumber } from '../../utils/money';
import { dayjs, TZ } from '../../utils/dates';
import { normalizeCategoryName } from '../../utils/normalize';
import { inferCategory } from '../../domain/categorizer';
import { DEFAULT_PAYMENT_METHOD } from '../../utils/paymentMethod';
import { CARD_SELECT, CardSummary, findCardByNameGuess } from '../../services/cardService';
import { createInstallmentExpenses } from '../../services/installmentService';
import { getInvoiceMonthForPurchase } from '../../utils/installments';
import type { AuthedRequest } from '../middleware/auth';

const CURRENCY_FORMATTER = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatAmount(value: number) {
  return CURRENCY_FORMATTER.format(value);
}

function buildInstallmentSummary(description: string, totalCents: number, installments: number) {
  const totalString = formatAmount(centsToNumber(totalCents));
  const monthlyString = formatAmount((totalCents / installments) / 100);
  return `${description} — ${totalString} em ${installments}x (${monthlyString}/mês)`;
}

function buildSingleSummary(description: string, amountCents: number) {
  return `${description} — ${formatAmount(centsToNumber(amountCents))}`;
}

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
  paymentMethod: string;
  cardId: number | null;
  description: string;
  date: Date;
  source: string;
  rawText: string;
  createdAt: Date;
  category: { name: string };
  card?: CardSummary | null;
  installmentGroupId?: string | null;
  installmentIndex?: number | null;
  installmentsTotal?: number | null;
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
    installmentGroupId: expense.installmentGroupId ?? null,
    installmentIndex: expense.installmentIndex ?? null,
    installmentsTotal: expense.installmentsTotal ?? 1,
  };
}

function buildInstallmentDate(base: ReturnType<typeof dayjs>, offset: number) {
  const candidate = base.add(offset, 'month');
  const desiredDay = Math.min(base.date(), candidate.endOf('month').date());
  return candidate.date(desiredDay).startOf('day');
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

  const parcelInfo = parseInstallmentPattern(rawText);
  const installmentInfo = parseInstallments(parcelInfo.cleanedText);
  const paymentInfo = parsePayment(installmentInfo.cleanedText);

  let parsed;
  try {
    // Use the last numeric value to align with quick entry input (ex: "gasolina 20 hoje 35").
    parsed = parseQuickEntryText(paymentInfo.cleanedText, {
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
  parsed.paymentMethod = paymentInfo.paymentMethod ?? DEFAULT_PAYMENT_METHOD;
  parsed.cardNameGuess = paymentInfo.cardNameGuess;
  parsed.rawText = rawText;
  parsed.installmentsTotal = installmentInfo.installmentsTotal ?? 1;
  parsed.installmentCurrent = parcelInfo.current ?? undefined;
  parsed.installmentTotal = parcelInfo.total ?? undefined;
  parsed.purchaseLabel = parcelInfo.purchaseLabel ?? parsed.description;
  const matchedCard =
    parsed.paymentMethod === 'CREDIT'
      ? await findCardByNameGuess(user.id, parsed.cardNameGuess)
      : null;

  const installmentsTotal = parsed.installmentsTotal ?? 1;
  const shouldInstall =
    installmentsTotal > 1 && parsed.paymentMethod === 'CREDIT' && matchedCard;

  if (shouldInstall) {
    const { groupId, expenses, amounts } = await createInstallmentExpenses({
      userId: user.id,
      cardId: matchedCard!.id,
      categoryId: category.id,
      description: parsed.description || 'Sem descricao',
      amountCents,
      date: parsed.date,
      rawText: parsed.rawText,
      purchaseLabel: parsed.purchaseLabel ?? parsed.description,
      paymentMethod: 'CREDIT',
      source: 'pwa-quick',
      installmentsTotal,
      appendInstallmentLabel: true,
      closingDay: matchedCard!.closingDay,
    });

    const created = expenses.map(mapExpense);
    console.info(
      `[quick-entry] userId=${user.id} amountCents=${amountCents} installments=${installmentsTotal}`,
    );

    const perInstallmentAmount =
      amounts.length > 0 ? centsToNumber(amounts[0]) : centsToNumber(amountCents / installmentsTotal);
    return res.status(201).json({
      created,
      installmentGroupId: groupId,
      totalAmount: centsToNumber(amountCents),
      installmentsTotal,
      installments: installmentsTotal,
      perInstallmentAmount,
      firstDate: created[0].date,
      summary: buildInstallmentSummary(parsed.description, amountCents, installmentsTotal),
      categoryInferred,
      categoryConfidence,
      parsed: {
        description: parsed.description,
        amount: centsToNumber(amountCents),
        amountCents,
        categoryName: category.name,
        date: parsed.dateKey,
        installmentsTotal,
      },
    });
  }

  const invoiceMonth =
    parsed.paymentMethod === 'CREDIT' && matchedCard?.closingDay
      ? getInvoiceMonthForPurchase(parsed.date, matchedCard.closingDay)
      : dayjs(parsed.date).tz(TZ).format('YYYY-MM');

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents,
      paymentMethod: parsed.paymentMethod,
      cardId: matchedCard?.id ?? null,
      description: parsed.description || 'Sem descricao',
      date: parsed.date,
      source: 'pwa-quick',
      rawText: parsed.rawText,
      purchaseLabel: parsed.purchaseLabel ?? parsed.description,
      postedMonth: invoiceMonth,
      invoiceMonth,
      installmentIndex: 1,
      installmentsTotal: parsed.installmentsTotal ?? 1,
      installmentCurrent: parsed.installmentCurrent ?? null,
      installmentTotal: parsed.installmentTotal ?? null,
    },
    include: { category: true, card: { select: CARD_SELECT } },
  });

  console.info(`[quick-entry] userId=${user.id} amountCents=${amountCents}`);

  const entry = mapExpense(expense);

  return res.status(201).json({
    ...entry,
    entry,
    summary: buildSingleSummary(parsed.description, amountCents),
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
