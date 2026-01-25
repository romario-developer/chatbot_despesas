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
import { formatDate, nowBahia, normalizeDateOnly } from '../../utils/dates';

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
  month: z.string().optional(),
});

const FIELD_LABELS: Record<PendingQuestion, string> = {
  amount: 'valor',
  card: 'cartão de crédito',
  description: 'descrição',
  paymentMethod: 'forma de pagamento',
  none: '',
};
const PAYMENT_LABELS: Record<string, string> = {
  PIX: 'Pix',
  CASH: 'Dinheiro',
  DEBIT: 'Débito',
  CREDIT: 'Crédito',
};

function ensureArrays(target: any) {
  target.cards = Array.isArray(target.cards) ? target.cards : [];
  target.suggestedActions = Array.isArray(target.suggestedActions) ? target.suggestedActions : [];
  return target;
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
      return 'Qual foi o valor do gasto?';
    case 'description':
      return 'O que você comprou ou pagou?';
    case 'paymentMethod':
      return 'Como você pagou? Pix, débito, crédito ou dinheiro.';
    case 'card':
      return 'Qual cartão de crédito foi usado?';
    default:
      return 'Pode me contar mais sobre o gasto?';
  }
}

function buildQuestionActions(field: PendingQuestion) {
  if (field === 'none') return [];
  return [
    {
      id: `assistant-answer-${field}`,
      label: `Informar ${FIELD_LABELS[field]}`,
      payload: { field },
    },
  ];
}

function buildConfirmationActions() {
  return [
    { id: 'assistant-undo', label: 'Desfazer', payload: { kind: 'assistant-undo' } },
    { id: 'assistant-change-payment', label: 'Trocar pagamento', payload: { kind: 'assistant-change', field: 'paymentMethod' } },
    { id: 'assistant-change-category', label: 'Trocar categoria', payload: { kind: 'assistant-change', field: 'category' } },
  ];
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

  let state = await getAssistantConversationState(convId, userId);

  if (isUndoRequest(normalizedLower)) {
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
              assistantMessage: 'Certo, desfiz o último gasto que registrei.',
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

      return res
        .status(200)
        .json(
          ensureArrays({
            conversationId: convId,
            assistantMessage: questionForField(missingField),
            cards: [],
            suggestedActions: buildQuestionActions(missingField),
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

    let assistantMessage = `Registrei ${categoryName} — ${formatCurrency(amount)} no ${getPaymentLabel(
      paymentMethod,
    )} em ${formatDate(date)} para "${finalDescription}".`;
    if (assumedDate) {
      assistantMessage += ' Presumi que a data foi hoje; diga "trocar data" ou "desfazer" se quiser ajustar.';
    }

    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage,
          cards: [],
          suggestedActions: buildConfirmationActions(),
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
