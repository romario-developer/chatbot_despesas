import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";

import { AuthedRequest } from "../middleware/auth";
import {
  tool_getDashboardSummary,
  tool_getPlanning,
  tool_getOpenInvoices,
  tool_getTopEntries,
} from "../../services/aiToolService";
import { dayjs, TZ } from "../../utils/dates";
import { formatCurrency } from "../../utils/money";
import { GoogleGenerativeAI } from "@google/generative-ai";

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const aiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});

const router = Router();
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const requestSchema = z.object({
  message: z.string().min(1),
  month: z.string().regex(MONTH_PATTERN).optional(),
  conversationId: z.string().optional(),
});

async function buildAssistantResponse(userId: number, targetMonth: string, message: string) {
  const toolsUsed = new Set<string>();
  const summary = await tool_getDashboardSummary(userId, targetMonth);
  toolsUsed.add("tool_getDashboardSummary");
  const planning = await tool_getPlanning(userId);
  toolsUsed.add("tool_getPlanning");
  const topEntries = await tool_getTopEntries(userId, targetMonth, 5);
  toolsUsed.add("tool_getTopEntries");

  const lower = message.toLowerCase();
  const asksForCards = /cartão|cartao|fatura|parcelas|credito|crédito/.test(lower);

  const cards: Array<Record<string, any>> = [];
  cards.push({
    type: "metric",
    title: `Saldo estimado (${targetMonth})`,
    data: {
      value: summary.balanceCents,
      currency: "BRL",
      detail: `Receitas: ${formatCurrency(summary.receitasCents)} • Gastos: ${formatCurrency(summary.totalExpensesCents)} • Em conta: ${formatCurrency(summary.saldoEmContaCents)}`,
    },
  });

  if (summary.totalPorCategoria.length) {
    cards.push({
      type: "chart",
      title: "Gastos por Categoria",
      data: summary.totalPorCategoria.slice(0, 4).map(item => ({
        name: item.category,
        value: item.total
      }))
    });
  }

  if (topEntries.length) {
    cards.push({
      type: "list",
      title: "Maiores gastos do mês",
      data: {
        items: topEntries.map((entry) => {
          const valueInCents = Math.round(entry.amount * 100); 
          return {
            title: entry.description,
            subtitle: `${entry.category} • ${entry.date}`,
            value: valueInCents,
            formattedValue: formatCurrency(valueInCents),
          };
        }),
      },
    });
  }

  const suggestedActions = [
    { id: "ai-top-expenses", label: "Ver maiores gastos", payload: { kind: "topEntries", month: targetMonth } },
    { id: "ai-compare-month", label: "Comparar com mês passado", payload: { kind: "compareMonth" } }
  ];

  const assistantMessage = `No mês de ${targetMonth} você teve ${summary.expensesCount} lançamentos, totalizando ${formatCurrency(summary.totalExpensesCents)}. O saldo em conta está em ${formatCurrency(summary.balanceCents)}.`;

  return { assistantMessage, cards, suggestedActions, toolsUsed: Array.from(toolsUsed) };
}

router.post("/chat", async (req: AuthedRequest, res) => {
  const validation = requestSchema.safeParse(req.body ?? {});
  if (!validation.success) return res.status(400).json({ error: "Corpo inválido" });

  const { message, conversationId: providedId } = validation.data;
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const conversationId = providedId || randomUUID();
  const currentMonth = dayjs().tz(TZ).format("YYYY-MM");
  const lastMonth = dayjs().tz(TZ).subtract(1, "month").format("YYYY-MM");

  try {
    const userCategories = await prisma.category.findMany({ where: { userId: user.id } });
    const categoryNames = userCategories.map(c => c.name).join(", ");

    // 1. Descobre quem é o usuário logado
    const userName = user.name ? user.name : "Novo Usuário";
    const isNewUser = !user.name;

    // 2. Define a regra de saudação com base na hora do servidor
    const horaAtual = dayjs().tz(TZ).hour();
    let saudacaoTempo = "Bom dia";
    if (horaAtual >= 12 && horaAtual < 18) saudacaoTempo = "Boa tarde";
    else if (horaAtual >= 18) saudacaoTempo = "Boa noite";

    const prompt = `
      Você é o "Super Assistente", um consultor financeiro inteligente do app "Financio". 
      Mês atual: ${currentMonth}.
      Categorias já cadastradas: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      COMPORTAMENTO E PERSONALIDADE (MUITO IMPORTANTE):
      - O usuário logado se chama: ${userName}.
      ${isNewUser ? 
        `- ATENÇÃO: Este é um usuário novo. Seja muito acolhedor, dê as boas-vindas ao Financio e pergunte como ele gostaria de ser chamado.` : 
        `- Aja de forma humana, amigável e consultiva. Chame-o pelo nome.`
      }
      - Se a intenção for apenas "chat", varie as respostas usando "${saudacaoTempo}".
      - EVITE REPETIÇÕES: Se o usuário enviar apenas o registro de uma despesa ou meta, NÃO fique repetindo saudações ("Olá ${userName}"). Vá direto ao ponto!
      OBJETIVO:
      Retorne APENAS um objeto JSON válido, sem formatação markdown (sem \`\`\`json).

      Regras de Intenção (intent):
      1. "chat": Saudação, conversas ou dúvidas gerais.
      2. "expense": Registrar um gasto. "amount" DEVE SER SEMPRE POSITIVO. REGRA DE CATEGORIA: Tente ao máximo encaixar o gasto em uma das categorias já cadastradas que faça sentido. Só crie uma nova em última necessidade (e use nomes curtos).
      3. "dashboard": Pedir para ver relatórios, saldos gerais ou resumos do mês.
      4. "delete_last": O usuário pediu para apagar, desfazer ou cancelar o último lançamento.
      5. "compare": Comparar os gastos entre dois meses (ex: "gastei mais que o passado?", "como fui mês passado?").
      6. "set_budget": O usuário definiu um limite/meta de gastos para uma categoria (ex: "minha meta pra lazer é 200"). "amount" DEVE SER O VALOR DA META POSITIVO.

      Formato de Saída OBRIGATÓRIO (Mapeie method EXATAMENTE para CREDIT, PIX, DEBIT, CASH, TRANSFER ou OTHER):
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare" | "set_budget",
        "targetMonth": "${currentMonth}", 
        "compareMonth": "${lastMonth}", 
        "reply": "Sua resposta humanizada e inteligente aqui",
        "expenseDetails": { 
          "description": "Nome curto e direto do gasto", 
          "amount": 0, 
          "method": "PIX", 
          "category": "NomeDaCategoria" 
        }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim();
    textoResposta = textoResposta.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const aiDecision = JSON.parse(textoResposta);

    // --- 1. INTENÇÃO: DEFINIR META (SET_BUDGET) ---
    if (aiDecision.intent === "set_budget") {
      try {
        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category;

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });

        if (!planning) {
          planning = await prisma.planning.create({
            data: { userId: user.id, data: { categoryBudgets: {} } }
          });
        }

        const currentData = (planning.data as any) || {};
        if (!currentData.categoryBudgets) currentData.categoryBudgets = {};
        
        // Salva a meta em centavos
        currentData.categoryBudgets[categoryName] = amountCents;

        await prisma.planning.update({
          where: { id: planning.id },
          data: { data: currentData }
        });

        return res.status(200).json({
          conversationId,
          assistantMessage: `✅ Tudo certo! Sua meta de gastos para **${categoryName}** foi definida em **${formatCurrency(amountCents)}**. Vou monitorar para você!`,
          cards: [], suggestedActions: [{ label: "Quanto já gastei em " + categoryName }]
        });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Tive um problema ao salvar sua meta no banco.", cards: [] });
      }
    }

    // --- 2. INTENÇÃO: REGISTRAR DESPESA E CHECAR METAS ---
    if (aiDecision.intent === "expense") {
      try {
        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category || "Outros";
        const normalizedName = categoryName.toLowerCase().trim();
        
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName } });
        if (!category) {
          category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName } });
        }

        // Salva a despesa
        await prisma.expense.create({
          data: {
            userId: user.id, categoryId: category.id, amountCents,
            paymentMethod: aiDecision.expenseDetails.method,
            description: aiDecision.expenseDetails.description,
            date: new Date(), source: 'AI_CHAT', rawText: message
          }
        });

        // Verificando a meta (Budget)
        const summary = await tool_getDashboardSummary(user.id, currentMonth);
        const planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        
        const currentData = (planning?.data as any) || {};
        const budgets = currentData.categoryBudgets || {};
        
        // Procura a meta (aceita variações de maiúsculas/minúsculas)
        const metaEncontradaKey = Object.keys(budgets).find(k => k.toLowerCase() === normalizedName);
        const budgetCents = metaEncontradaKey ? budgets[metaEncontradaKey] : 0;
        
        const catSummary = summary.totalPorCategoria.find(c => c.category.toLowerCase() === normalizedName);
        const totalGastoAtual = catSummary ? catSummary.total : 0;

        let alertaBudget = "";
        if (budgetCents > 0) {
          const percentual = (totalGastoAtual / budgetCents) * 100;
          if (percentual >= 100) {
            alertaBudget = `\n\n🚨 **LIMITE ESTOURADO:** Você já gastou ${formatCurrency(totalGastoAtual)} e ultrapassou sua meta de ${formatCurrency(budgetCents)} para ${categoryName}!`;
          } else if (percentual >= 80) {
            alertaBudget = `\n\n⚠️ **ATENÇÃO:** Você já atingiu ${percentual.toFixed(0)}% da sua meta de ${categoryName}. Restam apenas ${formatCurrency(budgetCents - totalGastoAtual)}!`;
          }
        }

        return res.status(200).json({
          conversationId,
          assistantMessage: `${aiDecision.reply}${alertaBudget}\n\n✅ Lançamento salvo!\n🛒 **${aiDecision.expenseDetails.description}**\n💰 ${formatCurrency(amountCents)}\n📂 ${categoryName}`,
          cards: [], suggestedActions: [{ label: "Ver resumos" }, { label: "Desfazer último" }]
        });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Erro ao salvar despesa no banco.", cards: [] });
      }
    }

    // --- 3. INTENÇÃO: APAGAR ÚLTIMO ---
    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (!lastExpense) {
          return res.status(200).json({ conversationId, assistantMessage: "Não encontrei nenhum lançamento recente para apagar!", cards: [] });
        }
        await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({
          conversationId,
          assistantMessage: `🗑️ Feito! Eu apaguei: **${lastExpense.description}** (${formatCurrency(lastExpense.amountCents)}).`,
          cards: [], suggestedActions: []
        });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Tive um problema ao apagar.", cards: [] });
      }
    }

    // --- 4. INTENÇÃO: COMPARAÇÃO ---
    if (aiDecision.intent === "compare") {
      try {
        const month1 = aiDecision.targetMonth || currentMonth;
        const month2 = aiDecision.compareMonth || lastMonth;
        const summary1 = await tool_getDashboardSummary(user.id, month1);
        const summary2 = await tool_getDashboardSummary(user.id, month2);
        const diffCents = summary1.totalExpensesCents - summary2.totalExpensesCents;
        const economizou = diffCents <= 0;

        const cards = [{
          type: "metric", title: `Comparativo: ${month1} vs ${month2}`,
          data: {
            value: economizou ? Math.abs(diffCents) : -Math.abs(diffCents), 
            currency: "BRL",
            detail: `${month1}: ${formatCurrency(summary1.totalExpensesCents)}\n${month2}: ${formatCurrency(summary2.totalExpensesCents)}`
          }
        }];

        let resposta = aiDecision.reply;
        if (!resposta || resposta.length < 10) {
          resposta = economizou ? `Parabéns! Você gastou **${formatCurrency(Math.abs(diffCents))} a menos** em ${month1}.` : `Atenção! Você gastou **${formatCurrency(Math.abs(diffCents))} a mais** em ${month1}.`;
        }

        return res.status(200).json({ conversationId, assistantMessage: resposta, cards, suggestedActions: [] });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Erro ao comparar os meses.", cards: [] });
      }
    }

    // --- 5. INTENÇÃO: DASHBOARD ---
    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({
        conversationId, assistantMessage: aiDecision.reply || payload.assistantMessage,
        cards: payload.cards, suggestedActions: payload.suggestedActions,
      });
    }

    // --- 6. "CHAT" GENÉRICO ---
    return res.status(200).json({
      conversationId, assistantMessage: aiDecision.reply, cards: [], suggestedActions: [{ label: "Ver resumos" }]
    });

  } catch (err) {
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento. Tente novamente.", cards: [] });
  }
});

export default router;