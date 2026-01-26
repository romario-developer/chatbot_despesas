import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { AuthedRequest } from '../middleware/auth';
import { createExpense, deleteExpense } from '../../services/expenseService';
import { ensureDefaultCategory, getOrCreateCategory } from '../../services/categoryService';
import {
  AssistantStage,
  getAssistantConversationState,
  PendingExpenseDraft,
  PendingQuestion,
  upsertAssistantConversationState,
} from '../../services/assistantConversationService';
import { parseExpenseMessage } from '../../services/assistantExpenseParser';
import { formatCurrency } from '../../utils/money';
import { dayjs, nowBahia, normalizeDateOnly, TZ } from '../../utils/dates';
import { findCardByIdForUser, listCardsForUser } from '../../services/cardService';
import { createInstallmentExpenses } from '../../services/installmentService';
import { getInvoiceMonthForPurchase } from '../../utils/installments';

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
const STAGE_FOR_FIELD: Record<PendingQuestion, AssistantStage> = {
  description: 'ask_description',
  amount: 'ask_amount',
  paymentMethod: 'ask_payment',
  card: 'ask_card',
  none: 'confirming',
};

function ensureArrays(target: any) {
  target.cards = Array.isArray(target.cards) ? target.cards : [];
  target.suggestedActions = Array.isArray(target.suggestedActions) ? target.suggestedActions : [];
  return target;
}

function buildDraftResponse(draft: PendingExpenseDraft) {
  const result: Record<string, unknown> = {};
  if (typeof draft.amountCents === 'number') {
    result.amountCents = draft.amountCents;
  }
  if (draft.description) {
    result.description = draft.description;
  }
  if (draft.paymentMethod) {
    result.paymentMethod = draft.paymentMethod;
  }
  if (typeof draft.cardId === 'number') {
    result.cardId = draft.cardId;
  }
  if (draft.date) {
    result.date = draft.date.toISOString();
  }
  if (draft.categoryName) {
    result.categoryName = draft.categoryName;
  }
  if (typeof draft.installmentsTotal === 'number') {
    result.installmentsTotal = draft.installmentsTotal;
  }
  return Object.keys(result).length ? result : undefined;
}

function buildStatePayload(stage: AssistantStage, draft?: PendingExpenseDraft) {
  const payload: { stage: AssistantStage; draft?: Record<string, unknown> } = { stage };
  const draftResponse = draft ? buildDraftResponse(draft) : undefined;
  if (draftResponse) {
    payload.draft = draftResponse;
  }
  return payload;
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
    installmentsTotal: parsed.installmentsTotal ?? existing.installmentsTotal,
  };
}

function determineMissingField(draft: PendingExpenseDraft): PendingQuestion | null {
  if (!draft.description) return 'description';
  if (!draft.amountCents || draft.amountCents <= 0) return 'amount';
  if (draft.paymentMethod === 'CREDIT' && !draft.cardId) return 'card';
  if (!draft.paymentMethod) return 'paymentMethod';
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

function shouldResetConversation(stage?: AssistantStage) {
  return !stage || stage === 'idle' || stage === 'saved';
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

  if (includesGreeting(normalizedLower)) {
    const stage: AssistantStage = 'ask_description';
    await upsertAssistantConversationState({
      conversationId: convId,
      userId,
      pendingExpenseDraft: {},
      stage,
      lastExpenseId: state?.lastExpenseId ?? null,
    });
    logStage(userId, stage);
    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage: "Pode mandar a despesa. Ex: 'mercado 50' ou 'gastei 25 no pix'.",
          cards: [],
          suggestedActions: [],
          state: buildStatePayload(stage),
        }),
      );
  }

  if (isUndoRequest(normalizedLower)) {
    const stage: AssistantStage = 'idle';
    logStage(userId, stage);
    if (state?.lastExpenseId) {
      const removed = await deleteExpense(userId, state.lastExpenseId);
      if (removed) {
        await upsertAssistantConversationState({
          conversationId: convId,
          userId,
          pendingExpenseDraft: {},
          stage,
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
              state: buildStatePayload(stage),
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
          state: buildStatePayload(stage),
        }),
      );
  }

  const isFreshConversation = shouldResetConversation(state?.stage);
  const clearedDraft: PendingExpenseDraft = {
    amountCents: undefined,
    cardId: undefined,
    installmentsTotal: undefined,
  };
  const draftBase: PendingExpenseDraft = isFreshConversation ? clearedDraft : state?.pendingExpenseDraft ?? {};
  const lastExpenseId = state?.lastExpenseId ?? null;
  let fallbackStage: AssistantStage = state?.stage ?? 'idle';
  let fallbackDraft: PendingExpenseDraft | undefined = state?.pendingExpenseDraft;

  try {
    const parsed = await parseExpenseMessage(normalizedMessage, userId);
    const mergedDraft = mergeDraft(draftBase, parsed);
    const missingField = determineMissingField(mergedDraft);

    if (missingField) {
      const stage = STAGE_FOR_FIELD[missingField];
      await upsertAssistantConversationState({
        conversationId: convId,
        userId,
        pendingExpenseDraft: mergedDraft,
        stage,
        lastExpenseId,
      });

      const actions = await buildQuestionActions(missingField, userId);
      logStage(userId, stage);
      return res
        .status(200)
        .json(
          ensureArrays({
            conversationId: convId,
            assistantMessage: questionForField(missingField),
            cards: [],
            suggestedActions: actions,
            state: buildStatePayload(stage, mergedDraft),
          }),
        );
    }

    const confirmingStage: AssistantStage = 'confirming';
    fallbackStage = confirmingStage;
    fallbackDraft = mergedDraft;
    await upsertAssistantConversationState({
      conversationId: convId,
      userId,
      pendingExpenseDraft: mergedDraft,
      stage: confirmingStage,
      lastExpenseId,
    });

    const amount = mergedDraft.amountCents!;
    const finalDescription = mergedDraft.description ?? 'Sem descrição';
    const paymentMethod = mergedDraft.paymentMethod!;
    let date = mergedDraft.date;
    if (!date) {
      date = normalizeDateOnly(nowBahia().toDate()) ?? nowBahia().toDate();
    }
    const categoryName = mergedDraft.categoryName ?? 'Outros';
    const card = mergedDraft.cardId ? await findCardByIdForUser(userId, mergedDraft.cardId) : null;
    const requestedInstallments = mergedDraft.installmentsTotal ?? 1;
    const normalizedInstallments = Math.min(Math.max(requestedInstallments, 1), 36);
    const shouldCreateInstallments =
      paymentMethod === 'CREDIT' && card && normalizedInstallments > 1;

    let lastSavedExpenseId: number;
    const paymentSummaryLabel =
      paymentMethod === 'CREDIT' ? `Crédito ${card?.name ?? 'cartão'}` : getPaymentLabel(paymentMethod);
    let summary: string;

    if (shouldCreateInstallments) {
      await ensureDefaultCategory(userId);
      const category = await getOrCreateCategory(userId, categoryName);
      const { expenses } = await createInstallmentExpenses({
        userId,
        cardId: card!.id,
        categoryId: category.id,
        description: finalDescription,
        amountCents: amount,
        date,
        rawText: message,
        purchaseLabel: finalDescription,
        paymentMethod,
        source: 'assistant',
        installmentsTotal: normalizedInstallments,
        appendInstallmentLabel: true,
        closingDay: card!.closingDay,
      });
      lastSavedExpenseId = expenses[0].id;
      summary = `${finalDescription} — ${formatCurrency(amount)} em ${normalizedInstallments}x (${paymentSummaryLabel})`;
    } else {
      const invoiceMonth =
        paymentMethod === 'CREDIT' && card
          ? getInvoiceMonthForPurchase(date, card.closingDay)
          : dayjs(date).tz(TZ).format('YYYY-MM');
      const created = await createExpense(userId, {
        amountCents: amount,
        description: finalDescription,
        categoryName,
        date,
        rawText: message,
        paymentMethod,
        cardId: mergedDraft.cardId ?? undefined,
        installmentsTotal: 1,
        installmentIndex: 1,
        installmentCurrent: 1,
        installmentTotal: 1,
        invoiceMonth,
        postedMonth: invoiceMonth,
        source: 'assistant',
      });
      lastSavedExpenseId = created.expense.id;
      summary = `${finalDescription} — ${formatCurrency(amount)} (${paymentSummaryLabel})`;
    }

    const savedStage: AssistantStage = 'saved';
    await upsertAssistantConversationState({
      conversationId: convId,
      userId,
      pendingExpenseDraft: {},
      stage: savedStage,
      lastExpenseId: lastSavedExpenseId,
    });

    const assistantMessage = 'Registrado.';
    logStage(userId, savedStage);

    return res
      .status(200)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage,
          cards: [],
          suggestedActions: [],
          state: buildStatePayload(savedStage),
          uiHint: { kind: 'saved', summary },
        }),
      );
  } catch (err) {
    console.error('[assistant] expense error', err);
    const recoveryStage = fallbackStage;
    return res
      .status(500)
      .json(
        ensureArrays({
          conversationId: convId,
          assistantMessage: 'Não consegui registrar o gasto agora. Tente novamente em instantes.',
          cards: [],
          suggestedActions: [],
          state: buildStatePayload(recoveryStage, fallbackDraft),
        }),
      );
  }
});

export default router;
