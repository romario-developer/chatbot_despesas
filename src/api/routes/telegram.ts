import { Router } from 'express';
import { webhookCallback } from 'grammy';

import { AuthedRequest, authMiddleware } from '../middleware/auth';
import { noCacheMiddleware } from '../middleware/noCache';
import { bot } from '../../bot/botInstance';
import { getOrCreateUser } from '../../services/userService';
import { createLinkCode, getLinkStatus } from '../../services/telegramLinkService';
import { resolveAuthUserId } from '../utils/authUser';

const router = Router();

router.post('/webhook', webhookCallback(bot, 'express'));
router.get('/status', (_req, res) => {
  res.json({ ok: true });
});

const authed = Router();
authed.use(authMiddleware, noCacheMiddleware);

authed.post('/link-code', async (req: AuthedRequest, res) => {
  const telegramId = resolveAuthUserId(req);
  const user = await getOrCreateUser(telegramId);
  const result = await createLinkCode(user.id);
  return res.json({ code: result.code, expiresAt: result.expiresAt });
});

authed.get('/link-status', async (req: AuthedRequest, res) => {
  const telegramId = resolveAuthUserId(req);
  const user = await getOrCreateUser(telegramId);
  const status = await getLinkStatus(user.id);
  return res.json(status);
});

router.use(authed);

export default router;
