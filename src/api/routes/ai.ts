import { Router } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";

import { AuthedRequest } from "../middleware/auth";
import {
  tool_getDashboardSummary,
  tool_getPlanning,
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
  const topEntries = await tool_getTopEntries(userId, targetMonth, 5);

  const cards: Array<Record<string, any>> = [];
  cards.push({
    type: "metric",
    title: `Resumo (${targetMonth})`,
    data: { value: summary.balanceCents, currency: "BRL", detail: `Receitas: ${formatCurrency(summary.receitasCents)} • Gastos: ${formatCurrency(summary.totalExpensesCents)}` }
  });

  if (summary.totalPorCategoria.length) {
    cards.push({ type: "chart", title: "Gastos por Categoria", data: summary.totalPorCategoria.slice(0, 4).map(item => ({ name: item.category, value: item.total })) });
  }

  const suggestedActions = [{ id: "ai-compare-month", label: "Comparar meses", payload: { kind: "compareMonth" } }];
  const assistantMessage = `Neste mês você gastou ${formatCurrency(summary.totalExpensesCents)}. Seu saldo está em ${formatCurrency(summary.balanceCents)}.`;

  return { assistantMessage, cards, suggestedActions };
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

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    const userName = dbUser?.name || "";
    const isNewUser = !userName;

    if (message === "[SYSTEM_INIT]") {
      const horaAtual = dayjs().tz(TZ).hour();
      let saudacaoTempo = "Bom dia";
      if (horaAtual >= 12 && horaAtual < 18) saudacaoTempo = "Boa tarde";
      else if (horaAtual >= 18) saudacaoTempo = "Boa noite";

      if (userName) return res.status(200).json({ conversationId, assistantMessage: `${saudacaoTempo}, ${userName}! Como posso ajudar com suas finanças hoje?` });
      else return res.status(200).json({ conversationId, assistantMessage: `Olá! Bem-vindo ao Financio. Eu sou seu assistente inteligente. Como você gostaria que eu te chamasse?` });
    }

    const prompt = `
      Você é o "Super Assistente" do app "Financio". Mês: ${currentMonth}.
      Categorias cadastradas: [${categoryNames || "Nenhuma ainda"}].
      Mensagem do usuário: "${message}"

      COMPORTAMENTO E PERSONALIDADE:
      ${isNewUser ? 
        `- O usuário NÃO TEM NOME. Se ele falar um nome, classifique como "set_name". Responda: "Muito prazer, [Nome]!"` : 
        `- O usuário se chama ${userName}. Chame-o pelo nome.`
      }

      Regras de Intenção (intent):
      1. "chat": Conversas ou dúvidas.
      2. "expense": Registrar gasto.
      3. "dashboard": Pedir resumos/saldos.
      4. "delete_last": Apagar último lançamento.
      5. "compare": Comparar meses.
      6. "set_budget": Definir meta de gastos.
      7. "set_salary": Definir salário mensal do usuário.
      8. "add_extra": Adicionar um ganho extra / freela / bônus.
      9. "set_savings": Definir o valor que foi guardado na poupança / reserva.
      10. "set_name": Salvar o nome inicial do usuário.

      Formato OBRIGATÓRIO (sem marcadores Markdown):
      {
        "intent": "chat" | "expense" | "dashboard" | "delete_last" | "compare" | "set_budget" | "set_salary" | "add_extra" | "set_savings" | "set_name",
        "extractedName": "Nome capitalizado se set_name",
        "targetMonth": "${currentMonth}", 
        "reply": "Resposta humanizada",
        "expenseDetails": { "description": "Descrição", "amount": 0, "method": "PIX", "category": "Categoria" }
      }
    `;

    const result = await aiModel.generateContent(prompt);
    let textoResposta = result.response.text().trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const aiDecision = JSON.parse(textoResposta);

    // Salvar Nome
    if (aiDecision.intent === "set_name" && aiDecision.extractedName) {
      await prisma.user.update({ where: { id: user.id }, data: { name: aiDecision.extractedName } });
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || `Muito prazer, ${aiDecision.extractedName}! Já gravei seu nome aqui.`, refreshData: true });
    }

    // --- NOVAS INTENÇÕES DE PLANEJAMENTO ---
    if (["set_salary", "set_savings", "add_extra"].includes(aiDecision.intent)) {
      try {
        if (!aiDecision.expenseDetails || !aiDecision.expenseDetails.amount) {
          return res.status(200).json({ conversationId, assistantMessage: "Não entendi o valor exato. Poderia mandar de novo?" });
        }

        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { salaryByMonth: {}, extrasByMonth: {}, savingsByMonth: {} } } });

        const currentData = (planning.data as any) || {};

        if (aiDecision.intent === "set_salary") {
          if (!currentData.salaryByMonth) currentData.salaryByMonth = {};
          currentData.salaryByMonth[currentMonth] = amountCents;
        } else if (aiDecision.intent === "set_savings") {
          if (!currentData.savingsByMonth) currentData.savingsByMonth = {};
          currentData.savingsByMonth[currentMonth] = amountCents;
        } else if (aiDecision.intent === "add_extra") {
          if (!currentData.extrasByMonth) currentData.extrasByMonth = {};
          if (!currentData.extrasByMonth[currentMonth]) currentData.extrasByMonth[currentMonth] = [];
          
          currentData.extrasByMonth[currentMonth].push({
            id: `id-${Date.now()}`,
            date: new Date().toISOString().split("T")[0],
            description: aiDecision.expenseDetails.description || "Ganho Extra",
            amount: amountCents,
          });
        }

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });

        return res.status(200).json({
          conversationId,
          assistantMessage: `✅ Tudo certo! ${aiDecision.intent === 'set_salary' ? 'Seu salário' : aiDecision.intent === 'set_savings' ? 'Sua reserva' : 'Seu ganho extra'} foi registrado no planejamento. 💸`,
          refreshData: true
        });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, não consegui salvar no planejamento. Pode tentar de novo?" });
      }
    }

    // Definir Meta
    if (aiDecision.intent === "set_budget") {
      try {
        if (!aiDecision.expenseDetails || !aiDecision.expenseDetails.amount || !aiDecision.expenseDetails.category) {
          return res.status(200).json({ conversationId, assistantMessage: "Ops, não consegui pegar o valor ou a categoria da meta. Pode mandar novamente?" });
        }

        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category;
        const normalizedName = categoryName.toLowerCase().trim();

        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName } });

        let planning = await prisma.planning.findFirst({ where: { userId: user.id } });
        if (!planning) planning = await prisma.planning.create({ data: { userId: user.id, data: { categoryBudgets: {} } } });

        const currentData = (planning.data as any) || {};
        if (!currentData.categoryBudgets) currentData.categoryBudgets = {};
        
        // Salva usando o nome oficial e garantido da categoria do BD
        currentData.categoryBudgets[category.name] = amountCents;

        await prisma.planning.update({ where: { id: planning.id }, data: { data: currentData } });

        return res.status(200).json({ conversationId, assistantMessage: `✅ Meta para **${category.name}** definida em **${formatCurrency(amountCents)}**.`, refreshData: true });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Problema técnico ao salvar a meta. Pode tentar de novo?" });
      }
    }

    // Registrar Gasto
    if (aiDecision.intent === "expense") {
      try {
        const amountCents = Math.round(Math.abs(aiDecision.expenseDetails.amount) * 100);
        const categoryName = aiDecision.expenseDetails.category || "Outros";
        const normalizedName = categoryName.toLowerCase().trim();
        
        let category = await prisma.category.findFirst({ where: { userId: user.id, normalizedName } });
        if (!category) category = await prisma.category.create({ data: { userId: user.id, name: categoryName, normalizedName } });

        await prisma.expense.create({
          data: { userId: user.id, categoryId: category.id, amountCents, paymentMethod: aiDecision.expenseDetails.method, description: aiDecision.expenseDetails.description, date: new Date(), source: 'AI_CHAT', rawText: message }
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
          if (percentual >= 100) alertaBudget = `\n\n🚨 **ESTOUROU!** Você passou da meta de ${categoryName}!`;
          else if (percentual >= 80) alertaBudget = `\n\n⚠️ **ATENÇÃO:** Atingiu ${percentual.toFixed(0)}% da meta de ${categoryName}. Resta ${formatCurrency(budgetCents - totalGastoAtual)}.`;
        }

        return res.status(200).json({ conversationId, assistantMessage: `${aiDecision.reply}${alertaBudget}\n\n✅ Salvo! **${aiDecision.expenseDetails.description}** (${formatCurrency(amountCents)})`, refreshData: true });
      } catch (dbError) {
        return res.status(200).json({ conversationId, assistantMessage: "Ops, falha ao registrar o gasto." });
      }
    }

    if (aiDecision.intent === "delete_last") {
      try {
        const lastExpense = await prisma.expense.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        if (lastExpense) await prisma.expense.delete({ where: { id: lastExpense.id } });
        return res.status(200).json({ conversationId, assistantMessage: `🗑️ Apaguei: **${lastExpense?.description}**.`, refreshData: true });
      } catch (err) {
        return res.status(200).json({ conversationId, assistantMessage: "Problema ao apagar." });
      }
    }

    if (aiDecision.intent === "dashboard") {
      const payload = await buildAssistantResponse(user.id, aiDecision.targetMonth, message);
      return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply || payload.assistantMessage, cards: payload.cards, suggestedActions: payload.suggestedActions });
    }

    return res.status(200).json({ conversationId, assistantMessage: aiDecision.reply });

  } catch (err) {
    return res.status(200).json({ conversationId, assistantMessage: "Tive um problema de processamento." });
  }
});

export default router;