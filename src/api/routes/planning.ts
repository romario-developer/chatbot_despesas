import { Router } from 'express';

import { ApiError } from '../../errors/ApiError';
import { AuthedRequest } from '../middleware/auth';
import { planningUpdateBodySchema } from '../validators/planning';
import { getPlanningByUserId, savePlanningFromInput } from '../../services/planningService';

const router = Router();

function requireUser(req: AuthedRequest) {
  if (!req.user) {
    throw new ApiError('Unauthorized', { statusCode: 401, code: 'UNAUTHORIZED' });
  }
  return req.user;
}

router.get('/', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const planning = await getPlanningByUserId(user.id);
  return res.json(planning);
});

router.put('/', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const payload = planningUpdateBodySchema.parse(req.body ?? {});
  const saved = await savePlanningFromInput(user.id, payload);
  return res.json(saved);
});

export default router;
