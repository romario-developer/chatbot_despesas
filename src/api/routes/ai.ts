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

    const userName = user.name ? user.name : "";
    const isNewUser = !user.name;

    const horaAtual = dayjs().tz(TZ).hour();
    let saudacaoTempo = "Bom dia";
    if (horaAtual >= 12 && horaAtual < 18) saudacaoTempo = "Boa tarde";
    else if (horaAtual >= 18) saudacaoTempo = "Boa noite";

    const prompt = `
      Você é o "Super Assistente", um consultor financeiro inteligente do app "Financio". 
      Mês atual: ${currentMonth}.
      Categorias cadastradas: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      COMPORTAMENTO E PERSONALIDADE:
      ${isNewUser ? 
        `- O NOME DO USUÁRIO ESTÁ VAZIO NO BANCO DE DADOS. 
         - Se a mensagem dele for um nome (ex: "Romário", "meu nome é Ana"), classifique a intent OBRIGATORIAMENTE como "set_name".
         - IMPORTANTE: No campo "reply", responda confirmando que gravou o nome e seja simpático (ex: "Muito prazer, Romário!"). NUNCA escreva o termo "Novo Usuário" na sua resposta.` : 
        `- O usuário se chama ${userName}. Chame-o pelo nome de forma natural e amigável.`
      }
      - Se for "chat", varie as respostas usando "${saudacaoTempo}".
      - EVITE REPETIÇÕES: Ao registrar despesa ou meta, NÃO fique repetindo saudações ("Olá Romário"). Vá direto ao ponto, comemore economia ou alerte sobre gastos.

      Regras de Intenção (intent):
      1. "chat": Saudação ou conversa.
      2. "expense": Registrar gasto numérico.
      3. "dashboard": Resumos ou relatórios.
      4. "delete_last": Apagar último
       lançamento.
      5. "compare": Comparar meses.
      6. "set_budget": Definir limite/meta de gastos.
      7. "set_name": O usuário informou o nome dele para cadastro inicial.

      Formato de Saída OBRIGATÓRIO (Mapeie method para CREDIT, PIX, DEBIT, CASH, TRANSFER ou OTHER):
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare" | "set_budget" | "set_name",
        "extractedName": "Apenas o Nome capitalizado extraído (Ex: Romário). Vazio se não for set_name",
        "targetMonth": "${currentMonth}", 
        "compareMonth": "${lastMonth}", 
        "reply": "Sua resposta humanizada",
        "expenseDetails": { "description": "Nome", "amount": 0, "method": "PIX", "category": "Categoria" }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const aiDecision = JSON.parse(textoResposta);

    // --- 0. INTENÇÃO: SALVAR NOME ---
    if (aiDecision.intent === "set_name" && aiDecision.extractedName) {
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { name: aiDecision.extractedName }
        });
        return res.status(200).json({
          conversationId,
          // Usamos a própria resposta humanizada que a IA gerou baseada no nome!
          assistantMessage: aiDecision.reply || `Muito prazer, ${aiDecision.extractedName}! Já gravei seu nome aqui no sistema. O que vamos fazer hoje?`,
          cards: [], suggestedActions: []
        });
      } catch (err) {
         return res.status(200).json({ conversationId, assistantMessage: "Desculpe, deu um erro ao salvar seu nome no banco." });
      }
    }

    // --- 1. INTENÇÃO: DEFINIR META (SET_BUDGET) ---
    if (aiDecision.intent === "set_budget") {
      try {
        // TRAVA DE SEGURANÇA: Se a IA não trouxer valor ou categoria, pede pra repetir
        if (!aiDecision.expenseDetails || !aiDecision.expenseDetails.amount || !aiDecision.expenseDetails.category) {
          return res.status(200).json({
            conversationId,
            assistantMessage: "Ops, eu me confundi e não consegui pegar o valor exato ou a categoria da sua meta. 😅 Poderia mandar novamente de forma mais direta?",
            cards: [], suggestedActions: []
          });
        }

        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category;
        const normalizedName = categoryName.toLowerCase().trim();

        // NOVIDADE: Cria a categoria caso o usuário crie uma meta para algo novo
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName } });
        if (!category) {
          category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName } });
        }

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) {
          planning = await prisma.planning.create({ data: { userId: user.id, data: { categoryBudgets: {} } } });
        }

        const currentData = (planning.data as any) || {};
        if (!currentData.categoryBudgets) currentData.categoryBudgets = {};
        
        // Salva a meta usando o nome oficial da categoria
        currentData.categoryBudgets[categoryName] = amountCents;

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });

        return res.status(200).json({
          conversationId,
          assistantMessage: `✅ Perfeito! Sua meta para **${categoryName}** foi registrada em **${formatCurrency(amountCents)}**. Vou ficar de olho! 👀`,
          cards: [], suggestedActions: [{ label: "Ver resumos" }]
        });
      } catch (err) {
        // ERRO HUMANIZADO
        return res.status(200).json({ 
          conversationId, 
          assistantMessage: "Ops, tive um contratempo técnico ao tentar salvar sua meta no banco de dados. 😔 Poderia tentar enviar novamente?" 
        });
      }
    }

    // --- 2. INTENÇÃO: REGISTRAR DESPESA E CHECAR METAS ---
    if (aiDecision.intent === "expense") {
      try {
        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category || "Outros";
        const normalizedName = categoryName.toLowerCase().trim();
        
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName } });

        await prisma.expense.create({
          data: {
            userId: user.id, categoryId: category.id, amountCents,
            paymentMethod: aiDecision.expenseDetails.method, description: aiDecision.expenseDetails.description,
            date: new Date(), source: 'AI_CHAT', rawText: message
          }
        });

        const summary = await tool_getDashboardSummary(user.id, currentMonth);
        const planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        
        const currentData = (planning?.data as any) || {};
        const budgets = currentData.categoryBudgets || {};
        const metaEncontradaKey = Object.keys(budgets).find(k => k.toLowerCase() === normalizedName);
        const budgetCents = metaEncontradaKey ? budgets[metaEncontradaKey] : 0;
        
        const catSummary = summary.totalPorCategoria.find(c => c.category.toLowerCase() === normalizedName);
        const totalGastoAtual = catSummary ? catSummary.total : 0;

        let alertaBudget = "";
        if (budgetCents > 0) {
          const percentual = (totalGastoAtual / budgetCents) * 100;
          if (percentual >= 100) alertaBudget = `\n\n🚨 **ESTOUROU!** Você já gastou ${formatCurrency(totalGastoAtual)} e passou da meta para ${categoryName}!`;
          else if (percentual >= 80) alertaBudget = `\n\n⚠️ **ATENÇÃO:** Você atingiu ${percentual.toFixed(0)}% da meta de ${categoryName}. Resta ${formatCurrency(budgetCents - totalGastoAtual)}!`;
        }

        return res.status(200).json({
          conversationId,
          assistantMessage: `${aiDecision.reply}${alertaBudget}\n\n✅ Salvo!\n🛒 **${aiDecision.expenseDetails.description}**\n💰 ${formatCurrency(amountCents)}\n📂 ${categoryName}`,
          cards: [], suggestedActions: [{ label: "Ver resumos" }, { label: "Desfazer último" }]
        });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, dei um tropeço aqui ao salvar esse lançamento. Pode mandar de novo? 🙏" });
      }
    }

    // --- 3. INTENÇÃO: APAGAR ÚLTIMO ---
    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (!lastExpense) return res.status(200).json({ conversationId, assistantMessage: "Nenhum lançamento recente encontrado." });
        
        await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({ conversationId, assistantMessage: `🗑️ Apaguei: **${lastExpense.description}**.` });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Putz, não consegui apagar a última despesa. Pode tentar de novo? 😅" });
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
          data: { value: economizou ? Math.abs(diffCents) : -Math.abs(diffCents), currency: "BRL", detail: `${month1}: ${formatCurrency(summary1.totalExpensesCents)}\n${month2}: ${formatCurrency(summary2.totalExpensesCents)}` }
        }];

        let resposta = aiDecision.reply || (economizou ? `Gastou **${formatCurrency(Math.abs(diffCents))} a menos**.` : `Gastou **${formatCurrency(Math.abs(diffCents))} a mais**.`);
        return res.status(200).json({ conversationId, assistantMessage: resposta, cards, suggestedActions: [] });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Não conseguir comparar, pode me mandar novamente de forma mais clara? 😅." });
      }
    }

    // --- 5. INTENÇÃO: DASHBOARD ---
    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || payload.assistantMessage, cards: payload.cards, suggestedActions: payload.suggestedActions });
    }

    // --- 6. "CHAT" GENÉRICO ---
    return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply, cards: [], suggestedActions: [{ label: "Ver resumos" }] });

  } catch (err) {
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento." });
  }
});

export default router;