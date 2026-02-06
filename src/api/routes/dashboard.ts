import { Router } from 'express';

import { getDashboardSummary } from '../../services/dashboardService';
import { monthParamSchema } from '../validators/params';
import { AuthedRequest } from '../middleware/auth';
import { ApiError } from '../../errors/ApiError';

const router = Router();

function requireUser(req: AuthedRequest) {
  if (!req.user) {
    throw new ApiError('Unauthorized', { statusCode: 401, code: 'UNAUTHORIZED' });
  }
  return req.user;
}

router.get('/summary', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const { month } = monthParamSchema.parse(req.query);
  const summary = await getDashboardSummary(user.id, month);
  return res.json(summary);
});

export default router;
