import { Router } from 'express';

import type { AuthedRequest } from '../middleware/auth';

const router = Router();

router.get('/whoami', (req: AuthedRequest, res) => {
  return res.json({ user: req.user ?? null });
});

export default router;
