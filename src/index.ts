import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import apiRouter from "./api";
import { bot } from "./bot/botInstance";
import "./utils/dates";

dotenv.config();
process.env.TZ = "America/Fortaleza";

const PWA_ORIGIN = process.env.PWA_ORIGIN;
if (!PWA_ORIGIN) throw new Error("Defina PWA_ORIGIN nas variaveis de ambiente");

const PORT = Number(process.env.PORT) || 3000;

/**
 * Detecta se esta rodando no Render:
 * - Render costuma expor RENDER e PORT
 */
const IS_RENDER = Boolean(process.env.RENDER);

/**
 * URL base publica para webhook:
 * - So tenta registrar se WEBHOOK_URL estiver definida
 */
const baseUrl = (process.env.WEBHOOK_URL || "").trim();

const app = express();
const allowedOrigins = [PWA_ORIGIN];
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}

const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 500;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeSetWebhookWithRetry(webhookUrl: string) {
  for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt += 1) {
    try {
      await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
      console.log(`[webhook] Registrado em ${webhookUrl} (tentativa ${attempt})`);
      return;
    } catch (err) {
      console.error(`[webhook] Falha ao registrar (tentativa ${attempt}/${MAX_WEBHOOK_ATTEMPTS}):`, err);
      if (attempt < MAX_WEBHOOK_ATTEMPTS) {
        const delay = WEBHOOK_BASE_DELAY_MS * 2 ** (attempt - 1);
        await wait(delay);
      }
    }
  }

  console.error(`[webhook] Não foi possível registrar após ${MAX_WEBHOOK_ATTEMPTS} tentativas. Continuando sem webhook.`);
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
  const webhookPath = "/api/telegram/webhook";
  const webhookUrl = baseUrl ? new URL(webhookPath, baseUrl).toString() : null;

  if (webhookUrl) {
    await safeSetWebhookWithRetry(webhookUrl);
  } else {
    console.log("WEBHOOK_URL não definida, pulando registro de webhook.");
  }

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
});

async function startWebhookOrPolling() {
  if (IS_RENDER) {
    await startWebhook();
  } else {
    await startPolling();
  }
}
