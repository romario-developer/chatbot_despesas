import { Router } from 'express';
import { webhookCallback } from 'grammy';

import { AuthedRequest, authMiddleware } from '../middleware/auth';
import { noCacheMiddleware } from '../middleware/noCache';
import { bot } from '../../bot/botInstance';
import { createLinkCode, getLinkStatus } from '../../services/telegramLinkService';

const router = Router();

router.post('/webhook', webhookCallback(bot, 'express'));
router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const authed = Router();
authed.use(authMiddleware, noCacheMiddleware);

authed.post('/link-code', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const result = await createLinkCode(req.user.id);
  return res.json({ code: result.code, expiresAt: result.expiresAt });
});

authed.get('/link-status', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const status = await getLinkStatus(req.user.id);
  return res.json(status);
});

authed.get('/status', async (req: AuthedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const status = await getLinkStatus(req.user.id);
  return res.json({
    connected: status.linked,
    ...(status.telegramChatId ? { telegramChatId: status.telegramChatId } : {}),
  });
});

router.use(authed);

export default router;
