import OpenAI from 'openai';
import { z } from 'zod';

const MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

const intentEnum = z.enum([
  'create_expense',
  'create_income',
  'update_last',
  'undo_last',
  'query_summary',
  'needs_clarification',
  'chitchat',
]);

const fieldsToUpdateSchema = z
  .object({
    amount: z.number().positive().optional(),
    description: z.string().min(1).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    paymentMethod: z.enum(['CASH', 'CREDIT']).optional(),
    paymentDetail: z.string().min(1).optional(),
    cardName: z.string().min(1).optional(),
    categoryName: z.string().min(1).optional(),
  })
  .optional()
  .or(z.literal(null));

const assistantSchema = z.object({
  intent: intentEnum,
  data: z.object({
    amount: z.number().positive().nullable(),
    description: z.string().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    paymentMethod: z.enum(['CASH', 'CREDIT']).nullable(),
    paymentDetail: z.string().min(1).nullable(),
    cardName: z.string().nullable(),
    categoryName: z.string().nullable(),
    fieldsToUpdate: fieldsToUpdateSchema,
    summaryRange: z.enum(['month']).nullable(),
  }),
  assistantMessage: z.string().min(1),
});

export type AssistantModelResponse = z.infer<typeof assistantSchema>;

function buildSystemPrompt() {
  return `
Você é uma assistente financeira no estilo humano e amigável.
Recebido um comando em português brasileiro, você responde estritamente com JSON (somente JSON, nenhum texto adicional).
Use o schema:
{
  "intent": "create_expense"|"create_income"|"update_last"|"undo_last"|"query_summary"|"needs_clarification"|"chitchat",
  "data": {...},
  "assistantMessage": "string"
}
Use os exemplos abaixo:
1) Usuário: "gastei 50 no mercado"
   => intent=create_expense, amount=50, description="mercado", paymentMethod=CASH, categoryName="Alimentação"
2) Usuário: "paguei 99,90 de internet no cartão inter"
   => intent=create_expense, amount=99.9, description="internet", paymentMethod=CREDIT, cardName="Inter", categoryName="Casa"
3) Usuário: "na verdade foi 60"
   => intent=update_last, fieldsToUpdate.amount=60
4) Usuário: "desfaz o último"
   => intent=undo_last
5) Usuário: "quanto gastei esse mês?"
   => intent=query_summary, summaryRange="month"
Se estiver inseguro sobre algum campo, use needs_clarification e peça o dado faltante.
Sempre confirme de forma breve e educada o que foi registrado.
`;
}

function extractJson(text: string) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new Error('JSON não encontrado na resposta do modelo');
  }
  return text.slice(first, last + 1);
}

export async function interpretAssistantMessage(message: string, month?: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key missing');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userContent = `Mensagem: "${message.trim()}"\nMês de referência: ${month || 'atual'}`;
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userContent },
    ],
  });

  const content = completion.choices?.[0]?.message?.content ?? '';
  const json = extractJson(content);
  return assistantSchema.parse(JSON.parse(json));
}
