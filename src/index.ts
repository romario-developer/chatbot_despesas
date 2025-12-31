import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { webhookCallback } from "grammy";

import apiRouter from "./api";
import { createBot } from "./bot/bot";
import "./utils/dates";

dotenv.config();
process.env.TZ = "America/Fortaleza";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Defina BOT_TOKEN nas variaveis de ambiente");
const PWA_ORIGIN = process.env.PWA_ORIGIN;
if (!PWA_ORIGIN) throw new Error("Defina PWA_ORIGIN nas variaveis de ambiente");

const PORT = Number(process.env.PORT) || 3000;

/**
 * Detecta se esta rodando no Render:
 * - Render costuma expor RENDER, RENDER_EXTERNAL_URL e PORT
 */
const IS_RENDER = Boolean(process.env.RENDER_EXTERNAL_URL || process.env.RENDER);

/**
 * URL base publica para webhook:
 * - No Render: use RENDER_EXTERNAL_URL (recomendado)
 * - Se voce quiser sobrescrever manualmente: defina WEBHOOK_URL
 */
const baseUrl = (process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "").trim();

const bot = createBot(BOT_TOKEN);

const app = express();
const allowedOrigins = [PWA_ORIGIN];
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  }),
);
app.use(express.json());
app.use("/api", apiRouter);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next(err);
});

async function startWebhook() {
  if (!baseUrl) {
    throw new Error(
      "Modo webhook ativo, mas nao encontrei URL base. Defina WEBHOOK_URL ou garanta RENDER_EXTERNAL_URL no Render.",
    );
  }

  const webhookPath = "/webhook";
  const webhookUrl = new URL(webhookPath, baseUrl).toString();

  app.post(webhookPath, webhookCallback(bot, "express"));

  await bot.api.setWebhook(webhookUrl);
  console.log("Webhook registrado em:", webhookUrl);

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT} (webhook)`);
  });
}

async function startPolling() {
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT} (polling)`);
  });

  bot.start();
}

startWebhookOrPolling().catch((err) => {
  console.error("Falha ao iniciar aplicacao:", err);
  process.exit(1);
});

async function startWebhookOrPolling() {
  if (IS_RENDER) {
    await startWebhook();
  } else {
    await startPolling();
  }
}
