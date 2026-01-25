import type { PaymentMethod } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';

export type PendingQuestion = 'none' | 'amount' | 'description' | 'paymentMethod' | 'card';

export type PendingExpenseDraft = {
  amountCents?: number;
  description?: string;
  paymentMethod?: PaymentMethod;
  cardId?: number;
  date?: Date;
  categoryName?: string;
};

const PENDING_QUESTIONS: PendingQuestion[] = ['none', 'amount', 'description', 'paymentMethod', 'card'];

function hydrateDraft(raw: unknown): PendingExpenseDraft {
  if (!raw) return {};
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    amountCents: typeof payload?.amountCents === 'number' ? payload.amountCents : undefined,
    description: typeof payload?.description === 'string' ? payload.description : undefined,
    paymentMethod: typeof payload?.paymentMethod === 'string' ? (payload.paymentMethod as PaymentMethod) : undefined,
    cardId: typeof payload?.cardId === 'number' ? payload.cardId : undefined,
    date: payload?.date ? new Date(payload.date) : undefined,
    categoryName: typeof payload?.categoryName === 'string' ? payload.categoryName : undefined,
  };
}

function prepareDraftForStorage(draft: PendingExpenseDraft) {
  const payload: Record<string, Prisma.InputJsonValue> = {};
  if (typeof draft.amountCents === 'number') payload.amountCents = draft.amountCents;
  if (draft.description) payload.description = draft.description;
  if (draft.paymentMethod) payload.paymentMethod = draft.paymentMethod;
  if (typeof draft.cardId === 'number') payload.cardId = draft.cardId;
  if (draft.date) payload.date = draft.date.toISOString();
  if (draft.categoryName) payload.categoryName = draft.categoryName;
  return payload;
}

export async function getAssistantConversationState(
  conversationId: string,
  userId: number,
): Promise<{
  pendingExpenseDraft: PendingExpenseDraft;
  pendingQuestion: PendingQuestion;
  lastExpenseId?: number;
} | null> {
  if (!conversationId) return null;
  const record = await prisma.assistantConversation.findUnique({
    where: { conversationId },
  });
  if (!record || record.userId !== userId) return null;
  const question = PENDING_QUESTIONS.includes(record.pendingQuestion as PendingQuestion)
    ? (record.pendingQuestion as PendingQuestion)
    : 'none';
  return {
    pendingExpenseDraft: hydrateDraft(record.pendingDraft),
    pendingQuestion: question,
    lastExpenseId: record.lastExpenseId ?? undefined,
  };
}

export async function upsertAssistantConversationState(params: {
  conversationId: string;
  userId: number;
  pendingExpenseDraft: PendingExpenseDraft;
  pendingQuestion: PendingQuestion;
  lastExpenseId?: number | null;
}) {
  const { conversationId, userId, pendingExpenseDraft, pendingQuestion, lastExpenseId } = params;
  const payload = prepareDraftForStorage(pendingExpenseDraft);
  const storedDraft = Object.keys(payload).length
    ? (payload as Prisma.InputJsonObject)
    : undefined;
  await prisma.assistantConversation.upsert({
    where: { conversationId },
    update: {
      userId,
      pendingDraft: storedDraft,
      pendingQuestion,
      lastExpenseId: lastExpenseId ?? null,
    },
    create: {
      conversationId,
      userId,
      pendingDraft: storedDraft,
      pendingQuestion,
      lastExpenseId: lastExpenseId ?? null,
    },
  });
}
