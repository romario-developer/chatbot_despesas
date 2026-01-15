import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import apiRouter, { API_BASE_PATH } from "./api";
import { bot } from "./bot/botInstance";
import "./utils/dates";

dotenv.config();
process.env.TZ = "America/Fortaleza";

process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL] unhandledRejection:", (reason as any)?.stack || reason);
});

process.on("uncaughtException", (err: any) => {
  console.error("[FATAL] uncaughtException:", (err as any)?.stack || err);
});

const IS_DEV = process.env.NODE_ENV !== "production";
const PWA_ORIGIN = process.env.PWA_ORIGIN;
if (!PWA_ORIGIN) throw new Error("Defina PWA_ORIGIN nas variaveis de ambiente");

const PORT = Number(process.env.PORT) || 3000;

/**
 * Detecta se esta rodando no Render:
 * - Render costuma expor RENDER e PORT
 */
const IS_RENDER = Boolean(process.env.RENDER);

const app = express();
const corsAllowedOrigins = new Set([
  "https://chatbot-despesas-pwa.onrender.com",
  "https://despesas-pwa.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
]);
if (PWA_ORIGIN) {
  corsAllowedOrigins.add(PWA_ORIGIN);
}

const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_BASE_DELAY_MS = 500;
const WEBHOOK_PATH = "/api/telegram/webhook";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWebhookUrl(): string | null {
  const raw = (process.env.WEBHOOK_URL || "").trim();
  if (!raw) return null;

  // Suporta o caso em que a variavel foi definida como "WEBHOOK_URL=https://..."
  const sanitized = raw.replace(/^WEBHOOK_URL=/i, "").trim();
  if (!sanitized) return null;

  try {
    const url = new URL(sanitized);

    const endsWithWebhook = url.pathname.endsWith("/webhook");
    const endsWithExact = url.pathname.endsWith(WEBHOOK_PATH);
    if (!endsWithExact && !endsWithWebhook) {
      const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      url.pathname = `${basePath}${WEBHOOK_PATH}`;
    }

    return url.toString();
  } catch (err) {
    console.error("[webhook] WEBHOOK_URL invalida, pulando registro:", err);
    return null;
  }
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

  console.error(`[webhook] Nao foi possivel registrar apos ${MAX_WEBHOOK_ATTEMPTS} tentativas. Continuando sem webhook.`);
}

const corsOptions = {
  origin: Array.from(corsAllowedOrigins),
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Admin-Token",
    "X-Requested-With",
    "Cache-Control",
    "Pragma",
    "Expires",
  ],
  credentials: false,
  optionsSuccessStatus: 204,
};
const corsMiddleware = cors(corsOptions);
app.options("/*", corsMiddleware);
app.use(corsMiddleware);
console.log(`[CORS] Enabled for origins: ${Array.from(corsAllowedOrigins).join(", ")}`);
app.use(express.json());
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[REQ] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});
app.use(API_BASE_PATH, apiRouter);

if (IS_DEV) {
  logApiRoutes();
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use((req: Request, res: Response) => {
  console.warn(`[app] 404 ${req.method} ${req.originalUrl}`);
  return res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next(err);
});

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error("[EXPRESS_ERROR]", req.method, req.originalUrl, err?.stack || err);
  return res.status(500).json({ error: "Internal Server Error" });
});

async function startWebhook() {
  const webhookUrl = resolveWebhookUrl();

  if (webhookUrl) {
    await safeSetWebhookWithRetry(webhookUrl);
  } else {
    console.log("WEBHOOK_URL nao definida ou invalida, pulando registro de webhook.");
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

function logApiRoutes() {
  const routes = [
    `${API_BASE_PATH}/health`,
    `${API_BASE_PATH}/auth (login: POST ${API_BASE_PATH}/auth/login)`,
    `${API_BASE_PATH}/telegram (status: GET ${API_BASE_PATH}/telegram/status, health: GET ${API_BASE_PATH}/telegram/health)`,
    `${API_BASE_PATH}/entries`,
    `${API_BASE_PATH}/categories`,
    `${API_BASE_PATH}/reports`,
    `${API_BASE_PATH}/summary`,
    `${API_BASE_PATH}/planning`,
  ];

  console.log(`[routes] API base path: ${API_BASE_PATH}`);
  routes.forEach((route) => console.log("[routes] Mounted:", route));
}
