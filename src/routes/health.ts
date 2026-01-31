import { Router } from 'express';

import { dbState, markDbError, markDbReady } from '../infra/db/dbState';
import { prisma } from '../infra/db/prisma';

const router = Router();

router.get('/health', async (_req, res) => {
  let ping: 'ok' | 'fail' = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
    markDbReady();
  } catch (error) {
    ping = 'fail';
    markDbError(error as Error | string | null);
  }

  return res.json({
    ok: true,
    service: 'chatbot_despesas',
    env: process.env.NODE_ENV ?? 'development',
    db: {
      ready: dbState.ready,
      lastOkAt: dbState.lastOkAt,
      lastError: dbState.lastError,
      ping,
    },
    now: new Date().toISOString(),
  });
});

export default router;
