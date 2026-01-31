import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import apiRouter, { API_BASE_PATH } from './api';
import healthRouter from './routes/health';
import './utils/dates';
import { markDbError, markDbReady } from './infra/db/dbState';
import { prisma } from './infra/db/prisma';

dotenv.config();
process.env.TZ = 'America/Fortaleza';

process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] unhandledRejection:', (reason as any)?.stack || reason);
});

process.on('uncaughtException', (err: any) => {
  console.error('[FATAL] uncaughtException:', (err as any)?.stack || err);
});

const PWA_ORIGIN = process.env.PWA_ORIGIN;
if (!PWA_ORIGIN) throw new Error('Defina PWA_ORIGIN nas variaveis de ambiente');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const corsAllowedOrigins = new Set([
  'https://despesas-pwa.onrender.com',
  'https://chatbot-despesas-pwa.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
]);
corsAllowedOrigins.add(PWA_ORIGIN);

const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (corsAllowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Admin-Token',
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
    'Expires',
  ],
  credentials: true,
};

const corsMiddleware = cors(corsOptions);
app.use(corsMiddleware);
app.use(express.json());
app.use(API_BASE_PATH, healthRouter);
app.use(API_BASE_PATH, apiRouter);

app.use((req: Request, res: Response) => {
  return res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err?.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  return next(err);
});

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error('[EXPRESS_ERROR]', req.method, req.originalUrl, err?.stack || err);
  return res.status(500).json({ error: 'Internal Server Error' });
});

const CONNECT_MAX_ATTEMPTS = 15;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10000;

async function connectWithRetry() {
  let attempts = 0;
  while (attempts < CONNECT_MAX_ATTEMPTS) {
    try {
      await prisma.$connect();
      markDbReady();
      console.log(`[DB] conectado com sucesso (tentativa ${attempts + 1})`);
      return;
    } catch (error) {
      attempts += 1;
      const message = error instanceof Error ? error.message : String(error ?? 'Erro desconhecido');
      markDbError(message);
      console.error(`[DB] falha ao conectar (tentativa ${attempts}): ${message}`);

      if (attempts >= CONNECT_MAX_ATTEMPTS) {
        console.warn('[DB] número máximo de tentativas atingido. Subindo em modo degradado.');
        return;
      }

      const delay = Math.min(BASE_DELAY_MS * attempts, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} recebido. Encerrando servidores...`);
  try {
    await prisma.$disconnect();
    console.log('[shutdown] Prisma desconectado');
  } catch (error) {
    console.error('[shutdown] erro ao desconectar Prisma', error);
  } finally {
    process.exit(0);
  }
}

async function startServer() {
  await connectWithRetry();
  const server = app.listen(PORT, () => {
    const env = process.env.NODE_ENV || 'development';
    console.log(`Servidor rodando na porta ${PORT} (${env})`);
  });

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal);
    });
  });

  return server;
}

void startServer();
