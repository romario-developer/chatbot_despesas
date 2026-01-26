import type { PaymentMethod } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';

export type PendingQuestion = 'none' | 'amount' | 'description' | 'paymentMethod' | 'card';
export type AssistantStage =
  | 'idle'
  | 'ask_description'
  | 'ask_amount'
  | 'ask_payment'
  | 'ask_card'
  | 'confirming'
  | 'saved';

export type PendingExpenseDraft = {
  amountCents?: number;
  description?: string;
  paymentMethod?: PaymentMethod;
  cardId?: number;
  date?: Date;
  categoryName?: string;
};

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

const STAGE_ORDER: AssistantStage[] = [
  'idle',
  'ask_description',
  'ask_amount',
  'ask_payment',
  'ask_card',
  'confirming',
  'saved',
];

function hydrateStage(value: string | null | undefined): AssistantStage {
  if (!value) return 'idle';
  const stage = value as AssistantStage;
  if (STAGE_ORDER.includes(stage)) return stage;
  return 'idle';
}

function stageToPendingQuestion(stage: AssistantStage): PendingQuestion {
  switch (stage) {
    case 'ask_amount':
      return 'amount';
    case 'ask_description':
      return 'description';
    case 'ask_payment':
      return 'paymentMethod';
    case 'ask_card':
      return 'card';
    case 'confirming':
      return 'none';
    default:
      return 'none';
  }
}

export async function getAssistantConversationState(
  conversationId: string,
  userId: number,
): Promise<{
  pendingExpenseDraft: PendingExpenseDraft;
  stage: AssistantStage;
  lastExpenseId?: number;
} | null> {
  if (!conversationId) return null;
  const record = await prisma.assistantConversation.findUnique({
    where: { conversationId },
  });
  if (!record || record.userId !== userId) return null;
  return {
    pendingExpenseDraft: hydrateDraft(record.pendingDraft),
    stage: hydrateStage(record.stage),
    lastExpenseId: record.lastExpenseId ?? undefined,
  };
}

export async function upsertAssistantConversationState(params: {
  conversationId: string;
  userId: number;
  pendingExpenseDraft: PendingExpenseDraft;
  stage: AssistantStage;
  lastExpenseId?: number | null;
}) {
  const { conversationId, userId, pendingExpenseDraft, stage, lastExpenseId } = params;
  const payload = prepareDraftForStorage(pendingExpenseDraft);
  const storedDraft = Object.keys(payload).length
    ? (payload as Prisma.InputJsonObject)
    : undefined;
  const pendingQuestion = stageToPendingQuestion(stage);
  await prisma.assistantConversation.upsert({
    where: { conversationId },
    update: {
      userId,
      pendingDraft: storedDraft,
      pendingQuestion,
      stage,
      lastExpenseId: lastExpenseId ?? null,
    },
    create: {
      conversationId,
      userId,
      pendingDraft: storedDraft,
      pendingQuestion,
      stage,
      lastExpenseId: lastExpenseId ?? null,
    },
  });
}
