import { prisma } from '../db/prisma';
import { ensureDefaultCategory, getOrCreateCategory } from './categoryService';
import { getOrCreateUser } from './userService';
import { ParsedExpense } from './parseExpenseText';

export async function createDraftFromParsed(telegramId: string, parsed: ParsedExpense) {
  const user = await getOrCreateUser(telegramId);
  await ensureDefaultCategory(user.id);
  const category = await getOrCreateCategory(user.id, parsed.categoryName || 'Outros');

  const draft = await prisma.expenseDraft.create({
    data: {
      userId: user.id,
      categoryId: category.id,
      amountCents: parsed.amountCents,
      description: parsed.description || 'Sem descrição',
      date: parsed.date,
      rawText: parsed.rawText,
    },
    include: { category: true },
  });

  return { draft, user, category };
}

export async function getDraftForUser(draftId: string, telegramId: string) {
  const user = await getOrCreateUser(telegramId);
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

  const updated = await prisma.expenseDraft.update({
    where: { id: draft.id },
    data,
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

  const expense = await prisma.expense.create({
    data: {
      userId: user.id,
      categoryId: draft.categoryId,
      amountCents: draft.amountCents,
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
