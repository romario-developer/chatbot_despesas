import { prisma } from '../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { ParsedExpense } from './parseExpenseText';
import { assertValidAmountCents } from '../utils/money';

export async function createDraftFromParsed(userId: number, parsed: ParsedExpense) {
  await ensureDefaultCategory(userId);
  const category = await getOrCreateCategory(userId, parsed.categoryName || 'Outros');
  const amountCents = assertValidAmountCents(parsed.amountCents, 'draft.amountCents');

  const draft = await prisma.expenseDraft.create({
    data: {
      userId,
      categoryId: category.id,
      amountCents,
      description: parsed.description || 'Sem descrição',
      date: parsed.date,
      rawText: parsed.rawText,
    },
    include: { category: true },
  });

  return { draft, userId, category };
}

export async function getDraftForUser(draftId: string, userId: number) {
  const draft = await prisma.expenseDraft.findFirst({
    where: { id: draftId, userId },
    include: { category: true },
  });
  return { draft, userId };
}

export async function updateDraft(
  draftId: string,
  userId: number,
  data: Partial<{
    amountCents: number;
    description: string;
    date: Date;
    categoryId: number;
  }>,
) {
  const { draft } = await getDraftForUser(draftId, userId);
  if (!draft) return null;

  const dataToUpdate = { ...data };
  if (typeof data.amountCents !== 'undefined') {
    dataToUpdate.amountCents = assertValidAmountCents(data.amountCents, 'draft.amountCents');
  }

  const updated = await prisma.expenseDraft.update({
    where: { id: draft.id },
    data: dataToUpdate,
    include: { category: true },
  });

  return { draft: updated, userId };
}

export async function deleteDraft(draftId: string, userId: number) {
  const { draft } = await getDraftForUser(draftId, userId);
  if (!draft) return null;
  await prisma.expenseDraft.delete({ where: { id: draft.id } });
  return { draft, userId };
}

export async function confirmDraft(draftId: string, userId: number) {
  const { draft } = await getDraftForUser(draftId, userId);
  if (!draft) return null;
  console.log('[telegram] saving expense', { userId });
  const amountCents = assertValidAmountCents(draft.amountCents, 'draft.amountCents');

  const expense = await prisma.expense.create({
    data: {
      userId,
      categoryId: draft.categoryId,
      amountCents,
      description: draft.description,
      date: draft.date,
      source: 'telegram-text',
      rawText: draft.rawText,
    },
    include: { category: true },
  });

  await prisma.expenseDraft.delete({ where: { id: draft.id } });

  return { expense, userId, draft };
}
