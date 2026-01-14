import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { dayjs, TZ } from '../../utils/dates';
import { AuthedRequest } from '../middleware/auth';
import { interpretAssistantMessage, AssistantModelResponse } from '../../services/assistantChatService';
import { ensureDefaultCategory } from '../../services/categoryService';
import { findCardByNameGuess } from '../../services/cardService';
import { toAmountCents, centsToNumber } from '../../utils/money';
import {
  getAssistantActionLog,
  upsertAssistantActionLog,
  deleteAssistantActionLog,
} from '../../services/assistantActionLogService';
import { prisma } from '../../db/prisma';

const router = Router();

const requestSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

async function resolveCategoryId(userId: number, categoryName?: string) {
  if (categoryName) {
    const candidate = await prisma.category.findFirst({
      where: {
        userId,
        name: { equals: categoryName.trim(), mode: 'insensitive' },
      },
    });
    if (candidate) return candidate.id;
  }
  const fallback = await ensureDefaultCategory(userId);
  return fallback.id;
}

async function resolveCardId(userId: number, cardName?: string | null) {
  if (!cardName) return null;
  const card = await findCardByNameGuess(userId, cardName);
  return card ? card.id : null;
}

function buildActionResponse(actionType: string, entity: 'Expense' | 'Income', entityId: number, summary: Record<string, any>) {
  return { type: actionType, entity, entityId, summary };
}

router.post('/chat', async (req: AuthedRequest, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(501).json({ error: 'Assistente não configurada (faltando OPENAI_API_KEY)' });
  }

  const validation = requestSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    return res.status(400).json({ error: 'Corpo inválido', details: validation.error.format() });
  }

  const { message, conversationId: providedConversationId, month } = validation.data;
  const conversationId = providedConversationId || randomUUID();
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await ensureDefaultCategory(user.id);
  try {
    const interpretation = await interpretAssistantMessage(message, month);
    return handleInterpretation(interpretation, user.id, conversationId, message, month, res);
  } catch (err) {
    console.error('[assistant] parse error', err);
    return res.status(502).json({ error: 'Erro ao interpretar a mensagem' });
  }
});

async function handleInterpretation(
  interpretation: AssistantModelResponse,
  userId: number,
  conversationId: string,
  rawMessage: string,
  month: string | undefined,
  res: any,
) {
  const { intent, data, assistantMessage } = interpretation;
  const responseBody = {
    conversationId,
    assistantMessage,
    actions: [] as Array<ReturnType<typeof buildActionResponse>>,
    suggestions: [],
  };

  const now = dayjs.tz(TZ);

  const sendResponse = (override?: Partial<typeof responseBody>) => {
    res.status(200).json({ ...responseBody, ...override });
  };

  if (intent === 'needs_clarification' || intent === 'chitchat') {
    sendResponse();
    return;
  }

  if (intent === 'query_summary') {
    const targetMonth = month ?? now.format('YYYY-MM');
    const parsedMonth = dayjs.tz(`${targetMonth}-01`, 'YYYY-MM-DD', TZ);
    if (!parsedMonth.isValid()) {
      sendResponse({ assistantMessage: 'Mês inválido. Use YYYY-MM.' });
      return;
    }
    const start = parsedMonth.startOf('month').toDate();
    const end = parsedMonth.endOf('month').toDate();
    const total = await prisma.expense.aggregate({
      where: { userId, date: { gte: start, lte: end } },
      _sum: { amountCents: true },
    });
    const totalNumber = centsToNumber(total._sum.amountCents ?? 0);
    sendResponse({
      assistantMessage: `Neste mês você gastou R$ ${totalNumber.toFixed(2)}.`,
    });
    return;
  }

  if (!data.amount && intent === 'create_expense' && !data.description) {
    sendResponse({ assistantMessage: 'Preciso de valor e descrição para registrar.' });
    return;
  }

  if (intent === 'create_expense' || intent === 'create_income') {
    if (!data.amount || !Number.isFinite(data.amount) || data.amount <= 0) {
      sendResponse({ assistantMessage: 'Valor inválido. Pode repetir sem símbolos?' });
      return;
    }
    const amountCents = toAmountCents(data.amount);
    if (!amountCents) {
      sendResponse({ assistantMessage: 'Valor inválido. Pode repetir em números?' });
      return;
    }
    const description = data.description?.trim() || 'Sem descrição';
    const paymentMethod = (data.paymentMethod ?? 'CASH') as 'CASH' | 'CREDIT';
    let cardId: number | null = null;
    if (paymentMethod === 'CREDIT') {
      cardId = await resolveCardId(userId, data.cardName);
      if (!cardId) {
        sendResponse({ assistantMessage: 'Qual cartão foi usado?' });
        return;
      }
    }
    const categoryId = await resolveCategoryId(userId, data.categoryName ?? undefined);
    const date = data.date ? dayjs.tz(data.date, 'YYYY-MM-DD', TZ) : now;
    if (!date.isValid()) {
      sendResponse({ assistantMessage: 'Data inválida, use YYYY-MM-DD.' });
      return;
    }
    const payload = {
      userId,
      categoryId,
      amountCents,
      paymentMethod,
      cardId,
      description,
      date: date.toDate(),
      rawText: rawMessage,
      source: intent === 'create_income' ? 'assistant-income' : 'assistant',
      categorySource: 'ASSISTANT',
    };
    const created = await prisma.expense.create({
      data: payload,
    });
    const entity = intent === 'create_income' ? 'Income' : 'Expense';
    await upsertAssistantActionLog(conversationId, entity, created.id);
    responseBody.actions.push(
      buildActionResponse(
        intent === 'create_income' ? 'income_created' : 'expense_created',
        entity,
        created.id,
        {
          amount: centsToNumber(amountCents),
          description,
          date: date.format('YYYY-MM-DD'),
        },
      ),
    );
    sendResponse();
    return;
  }

  if (intent === 'update_last') {
    const log = await getAssistantActionLog(conversationId);
    if (!log) {
      sendResponse({ assistantMessage: 'Não encontrei o último lançamento para corrigir.' });
      return;
    }
    if (!data.fieldsToUpdate) {
      sendResponse({ assistantMessage: 'O que deseja atualizar exatamente?' });
      return;
    }
    const fields = data.fieldsToUpdate;
    const updates: Record<string, any> = {};
    if (fields.amount) {
      const cents = toAmountCents(fields.amount);
      if (!cents) {
        sendResponse({ assistantMessage: 'Valor inválido. Pode repetir?' });
        return;
      }
      updates.amountCents = cents;
    }
    if (fields.description) {
      updates.description = fields.description.trim();
      updates.rawText = rawMessage;
    }
    if (fields.date) {
      const parsedDate = dayjs.tz(fields.date, 'YYYY-MM-DD', TZ);
      if (!parsedDate.isValid()) {
        sendResponse({ assistantMessage: 'Data inválida. Use YYYY-MM-DD.' });
        return;
      }
      updates.date = parsedDate.toDate();
    }
    if (fields.paymentMethod) {
      updates.paymentMethod = fields.paymentMethod;
    }
    if (fields.categoryName) {
      updates.categoryId = await resolveCategoryId(userId, fields.categoryName);
    }
    if (fields.cardName) {
      const cardId = await resolveCardId(userId, fields.cardName);
      if (!cardId) {
        sendResponse({ assistantMessage: 'Não encontrei esse cartão. Pode repetir?' });
        return;
      }
      updates.cardId = cardId;
    }
    const updated = await prisma.expense.update({
      where: { id: log.lastEntityId },
      data: updates,
    });
    await upsertAssistantActionLog(conversationId, 'Expense', updated.id);
    responseBody.actions.push(
      buildActionResponse('expense_updated', 'Expense', updated.id, {
        amount: centsToNumber(updated.amountCents),
        description: updated.description,
      }),
    );
    sendResponse();
    return;
  }

  if (intent === 'undo_last') {
    const log = await getAssistantActionLog(conversationId);
    if (!log) {
      sendResponse({ assistantMessage: 'Nada para desfazer por enquanto.' });
      return;
    }
    await prisma.expense.deleteMany({
      where: { id: log.lastEntityId },
    });
    await deleteAssistantActionLog(conversationId);
    responseBody.actions.push(
      buildActionResponse('expense_deleted', 'Expense', log.lastEntityId, {}),
    );
    sendResponse();
    return;
  }

  sendResponse();
}

export default router;
