import { prisma } from '../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { getAdminUser } from './userService';
import { ParsedExpense } from './parseExpenseText';
import { assertValidAmountCents } from '../utils/money';

export async function createDraftFromParsed(telegramId: string, parsed: ParsedExpense) {
  const user = await getAdminUser();
  await ensureDefaultCategory(user.id);
  const category = await getOrCreateCategory(user.id, parsed.categoryName || 'Outros');
  const amountCents = assertValidAmountCents(parsed.amountCents, 'draft.amountCents');

  const draft = await prisma.expenseDraft.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents,
      description: parsed.description || 'Sem descrição',
      date: parsed.date,
      rawText: parsed.rawText,
    },
    include: { category: true },
  });

  return { draft, user, category };
}

export async function getDraftForUser(draftId: string, telegramId: string) {
  const user = await getAdminUser();
  const draft = await prisma.expenseDraft.findFirst({
    where: { id: draftId, userId: user.id },
    include: { category: true },
  });
  return { draft, user };
}

export async function updateDraft(
  draftId: string,
  telegramId: string,
  data: Partial<{
    amountCents: number;
    description: string;
    date: Date;
    categoryId: number;
  }>,
) {
  const { draft, user } = await getDraftForUser(draftId, telegramId);
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

  return { draft: updated, user };
}

export async function deleteDraft(draftId: string, telegramId: string) {
  const { draft, user } = await getDraftForUser(draftId, telegramId);
  if (!draft) return null;
  await prisma.expenseDraft.delete({ where: { id: draft.id } });
  return { draft, user };
}

export async function confirmDraft(draftId: string, telegramId: string) {
  const { draft, user } = await getDraftForUser(draftId, telegramId);
  if (!draft) return null;
  console.log('[telegram] saving expense with userId=admin');
  const amountCents = assertValidAmountCents(draft.amountCents, 'draft.amountCents');

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
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

  return { expense, user, draft };
}
