import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { AuthedRequest } from '../middleware/auth';
import { createExpense, deleteExpense } from '../../services/expenseService';
import {
  getAssistantConversationState,
  PendingExpenseDraft,
  PendingQuestion,
  upsertAssistantConversationState,
} from '../../services/assistantConversationService';
import { parseExpenseMessage } from '../../services/assistantExpenseParser';
import { formatCurrency } from '../../utils/money';
import { nowBahia, normalizeDateOnly } from '../../utils/dates';
import { findCardByIdForUser, listCardsForUser } from '../../services/cardService';

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
  month: z.string().optional(),
});

const GREETING_KEYWORDS = ['oi', 'ola', 'olá', 'oie', 'e aí', 'e ai', 'bom dia', 'boa tarde', 'boa noite'];
const PAYMENT_LABELS: Record<string, string> = {
  PIX: 'Pix',
  CASH: 'Dinheiro',
  DEBIT: 'Débito',
  CREDIT: 'Crédito',
};
const PAYMENT_ACTIONS = [
  { id: 'assistant-pay-pix', label: 'Pix', payload: { paymentMethod: 'PIX' } },
  { id: 'assistant-pay-debit', label: 'Débito', payload: { paymentMethod: 'DEBIT' } },
  { id: 'assistant-pay-credit', label: 'Crédito', payload: { paymentMethod: 'CREDIT' } },
  { id: 'assistant-pay-cash', label: 'Dinheiro', payload: { paymentMethod: 'CASH' } },
];
const STAGE_FOR_FIELD: Record<PendingQuestion, string> = {
  amount: 'ask_amount',
  description: 'ask_desc',
  paymentMethod: 'ask_pay',
  card: 'ask_card',
  none: 'saved',
};

function ensureArrays(target: any) {
  target.cards = Array.isArray(target.cards) ? target.cards : [];
  target.suggestedActions = Array.isArray(target.suggestedActions) ? target.suggestedActions : [];
  return target;
}

function includesGreeting(text: string) {
  const normalized = text.trim().toLowerCase();
  return GREETING_KEYWORDS.some(
    (keyword) => normalized === keyword || normalized.startsWith(`${keyword} `) || normalized.includes(` ${keyword}`),
  );
}

function logStage(userId: number, stage: string) {
  if (process.env.NODE_ENV === 'production') return;
  console.log('[assistant]', { userId, stage });
}

async function buildQuestionActions(field: PendingQuestion, userId: number) {
  if (field === 'paymentMethod') {
    return PAYMENT_ACTIONS;
  }
  if (field === 'card') {
    const cards = await listCardsForUser(userId);
    return cards.map((card) => ({
      id: `assistant-card-${card.id}`,
      label: card.name,
      payload: { cardId: card.id },
    }));
  }
  return [];
}

function mergeDraft(existing: PendingExpenseDraft, parsed: Partial<PendingExpenseDraft>): PendingExpenseDraft {
  return {
    amountCents: parsed.amountCents ?? existing.amountCents,
    description: parsed.description ?? existing.description,
    paymentMethod: parsed.paymentMethod ?? existing.paymentMethod,
    cardId: parsed.cardId ?? existing.cardId,
    date: parsed.date ?? existing.date,
    categoryName: parsed.categoryName ?? existing.categoryName,
  };
}

function determineMissingField(draft: PendingExpenseDraft): PendingQuestion | null {
  if (!draft.amountCents || draft.amountCents <= 0) return 'amount';
  if (!draft.description) return 'description';
  if (!draft.paymentMethod) return 'paymentMethod';
  if (draft.paymentMethod === 'CREDIT' && !draft.cardId) return 'card';
  return null;
}

function questionForField(field: PendingQuestion) {
  switch (field) {
    case 'amount':
      return 'Qual foi o valor?';
    case 'description':
      return 'Gastou com o quê?';
    case 'paymentMethod':
      return 'Foi Pix, débito, crédito ou dinheiro?';
    case 'card':
      return 'Qual cartão?';
    default:
      return 'Pode me contar mais sobre o gasto?';
  }
}

function getPaymentLabel(method?: string) {
  if (!method) return 'forma de pagamento';
  return PAYMENT_LABELS[method] ?? method;
}

function isUndoRequest(message: string) {
  return message.includes('desfazer');
}

router.post('/chat', async (req: AuthedRequest, res) => {
  const validation = chatSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    return res.status(400).json({ error: 'Corpo inválido', details: validation.error.format() });
  }

  const { message, conversationId } = validation.data;
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const convId = conversationId || randomUUID();
  const normalizedMessage = message.trim();
  const normalizedLower = normalizedMessage.toLowerCase();

  if (includesGreeting(normalizedLower)) {
    logStage(userId, 'ask_amount');
    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage: "Pode mandar a despesa. Ex: 'mercado 50' ou 'gastei 25 no pix'.",
          cards: [],
          suggestedActions: [],
          state: { pendingQuestion: 'amount' },
        }),
      );
  }

  let state = await getAssistantConversationState(convId, userId);

  if (isUndoRequest(normalizedLower)) {
    logStage(userId, 'undo');
    if (state?.lastExpenseId) {
      const removed = await deleteExpense(userId, state.lastExpenseId);
      if (removed) {
        await upsertAssistantConversationState({
          conversationId: convId,
          userId,
          pendingExpenseDraft: {},
          pendingQuestion: 'none',
          lastExpenseId: null,
        });
        return res
          .status(200)
          .json(
            ensureArrays({
              conversationId: convId,
              assistantMessage: 'Ok, desfiz o último registro.',
              cards: [],
              suggestedActions: [],
              state: { pendingQuestion: 'none' },
            }),
          );
      }
    }
    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage: 'Não encontrei um gasto recente para desfazer.',
          cards: [],
          suggestedActions: [],
          state: { pendingQuestion: state?.pendingQuestion ?? 'none' },
        }),
      );
  }

  const draftBase: PendingExpenseDraft = state?.pendingExpenseDraft ?? {};

  try {
    const parsed = await parseExpenseMessage(normalizedMessage, userId);
    const mergedDraft = mergeDraft(draftBase, parsed);
    const missingField = determineMissingField(mergedDraft);

    if (missingField) {
      await upsertAssistantConversationState({
        conversationId: convId,
        userId,
        pendingExpenseDraft: mergedDraft,
        pendingQuestion: missingField,
        lastExpenseId: state?.lastExpenseId ?? null,
      });

      const actions = await buildQuestionActions(missingField, userId);
      const stage = STAGE_FOR_FIELD[missingField] ?? 'ask';
      logStage(userId, stage);
      return res
        .status(200)
        .json(
          ensureArrays({
            conversationId: convId,
            assistantMessage: questionForField(missingField),
            cards: [],
            suggestedActions: actions,
            state: { pendingQuestion: missingField },
          }),
        );
    }

    const amount = mergedDraft.amountCents!;
    const finalDescription = mergedDraft.description ?? 'Sem descrição';
    const paymentMethod = mergedDraft.paymentMethod!;
    let date = mergedDraft.date;
    if (!date) {
      date = normalizeDateOnly(nowBahia().toDate()) ?? nowBahia().toDate();
    }
    const categoryName = mergedDraft.categoryName ?? 'Outros';
    const assumedDate = !mergedDraft.date;
    const card = mergedDraft.cardId ? await findCardByIdForUser(userId, mergedDraft.cardId) : null;

    const created = await createExpense(userId, {
      amountCents: amount,
      description: finalDescription,
      categoryName,
      date,
      rawText: message,
      paymentMethod,
      cardId: mergedDraft.cardId ?? undefined,
    });

    await upsertAssistantConversationState({
      conversationId: convId,
      userId,
      pendingExpenseDraft: {},
      pendingQuestion: 'none',
      lastExpenseId: created.expense.id,
    });

    let paymentDescriptor = paymentMethod === 'CREDIT' ? `Crédito ${card?.name ?? 'cartão'}` : getPaymentLabel(paymentMethod);
    if (assumedDate) {
      paymentDescriptor += '; data assumida hoje';
    }

    const assistantMessage = `Registrado: ${finalDescription} — ${formatCurrency(amount)} (${paymentDescriptor})`;
    logStage(userId, 'saved');

    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage,
          cards: [],
          suggestedActions: [],
          state: { pendingQuestion: 'none' },
        }),
      );
  } catch (err) {
    console.error('[assistant] expense error', err);
    return res
      .status(500)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage: 'Não consegui registrar o gasto agora. Tente novamente em instantes.',
          cards: [],
          suggestedActions: [],
          state: { pendingQuestion: state?.pendingQuestion ?? 'none' },
        }),
      );
  }
});

export default router;
