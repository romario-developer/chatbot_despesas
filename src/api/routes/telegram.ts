import { Router } from 'express';
import { webhookCallback } from 'grammy';

import { AuthedRequest, authMiddleware } from '../middleware/auth';
import { noCacheMiddleware } from '../middleware/noCache';
import { bot } from '../../bot/botInstance';
import { getOrCreateUser } from '../../services/userService';
import { createLinkCode, getLinkStatus } from '../../services/telegramLinkService';

const router = Router();

router.post('/webhook', webhookCallback(bot, 'express'));
router.get('/status', (_req, res) => {
  res.json({ ok: true });
});

const authed = Router();
authed.use(authMiddleware, noCacheMiddleware);

authed.post('/link-code', async (req: AuthedRequest, res) => {
  const sub = req.auth?.sub ?? 'admin';
  const user = await getOrCreateUser(sub);
  const result = await createLinkCode(user.id);
  return res.json({ code: result.code, expiresAt: result.expiresAt });
});

authed.get('/link-status', async (req: AuthedRequest, res) => {
  const sub = req.auth?.sub ?? 'admin';
  const user = await getOrCreateUser(sub);
  const status = await getLinkStatus(user.id);
  return res.json(status);
});

router.use(authed);

export default router;
