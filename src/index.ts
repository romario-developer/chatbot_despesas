import dotenv from "dotenv";
import express from "express";
import { webhookCallback } from "grammy";
import type { Request, Response } from "express";

import "./utils/dates";
import { createBot } from "./bot/bot";

dotenv.config();
process.env.TZ = "America/Fortaleza";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Defina BOT_TOKEN nas variáveis de ambiente");

const PORT = Number(process.env.PORT) || 3000;

/**
 * Detecta se está rodando no Render:
 * - Render costuma expor RENDER, RENDER_EXTERNAL_URL e PORT
 */
const IS_RENDER = Boolean(process.env.RENDER_EXTERNAL_URL || process.env.RENDER);

/**
 * URL base pública para webhook:
 * - No Render: use RENDER_EXTERNAL_URL (recomendado)
 * - Se você quiser sobrescrever manualmente: defina WEBHOOK_URL
 */
const baseUrl = (process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "").trim();

const bot = createBot(BOT_TOKEN);

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

async function startWebhook() {
  if (!baseUrl) {
    throw new Error(
      "Modo webhook ativo, mas não encontrei URL base. Defina WEBHOOK_URL ou garanta RENDER_EXTERNAL_URL no Render."
    );
  }

  const webhookPath = "/webhook";
  const webhookUrl = new URL(webhookPath, baseUrl).toString();

  // rota que recebe updates do Telegram
  app.post(webhookPath, webhookCallback(bot, "express"));

  // registra webhook no Telegram
  await bot.api.setWebhook(webhookUrl);
  console.log("Webhook registrado em:", webhookUrl);

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT} (webhook)`);
  });
}

async function startPolling() {
  // garante que não existe webhook ativo
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT} (polling)`);
  });

  bot.start();
}

startWebhookOrPolling().catch((err) => {
  console.error("Falha ao iniciar aplicação:", err);
  process.exit(1);
});

async function startWebhookOrPolling() {
  if (IS_RENDER) {
    // Render: webhook
    await startWebhook();
  } else {
    // Local: polling
    await startPolling();
  }
}
