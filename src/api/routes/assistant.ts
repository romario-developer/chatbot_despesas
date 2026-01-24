import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const GREETING_KEYWORDS = ['oi', 'ola', 'olá', 'oie', 'e aí', 'e ai', 'bom dia', 'boa tarde', 'boa noite'];

const chatSchema = z.object({
  message: z.string().min(1),
  month: z.string().regex(MONTH_PATTERN).optional(),
  conversationId: z.string().optional(),
});

function includesGreeting(text: string) {
  const normalized = text.trim().toLowerCase();
  return GREETING_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

router.post('/chat', (req: AuthedRequest, res) => {
  const validation = chatSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    return res.status(400).json({ error: 'Corpo inválido', details: validation.error.format() });
  }

  const { message, month, conversationId } = validation.data;
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const convId = conversationId || randomUUID();
  let assistantMessage = 'Entendi. Por enquanto só posso responder saudações e perguntar sobre o mês.';
  if (includesGreeting(message)) {
    assistantMessage =
      'Oi! Quer analisar saldo, gastos, cartões ou planejamento? Qual mês você quer ver?';
  } else if (!month) {
    assistantMessage = 'Me diga qual mês deseja analisar (formato YYYY-MM).';
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('[assistant] chat', {
      userId,
      month: month ?? null,
      messagePreview: message.slice(0, 80),
    });
  }

  return res.status(200).json({
    conversationId: convId,
    assistantMessage,
    cards: [],
    suggestedActions: [],
    state: {
      month: month ?? null,
      topic: 'unknown',
      pendingQuestion: month ? 'none' : 'askMonth',
    },
  });
});

export default router;
