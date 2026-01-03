import { Router } from 'express';

import { AuthedRequest } from '../middleware/auth';
import { getOrCreateUser } from '../../services/userService';
import { createLinkCode, getLinkStatus } from '../../services/telegramLinkService';

const router = Router();

router.post('/link-code', async (req: AuthedRequest, res) => {
  const sub = req.auth?.sub ?? 'admin';
  const user = await getOrCreateUser(sub);
  const result = await createLinkCode(user.id);
  return res.json({ code: result.code, expiresAt: result.expiresAt });
});

router.get('/link-status', async (req: AuthedRequest, res) => {
  const sub = req.auth?.sub ?? 'admin';
  const user = await getOrCreateUser(sub);
  const status = await getLinkStatus(user.id);
  return res.json(status);
});

export default router;
