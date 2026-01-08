import { Router } from 'express';

import { listCategories } from '../../services/categoryService';
import { getOrCreateUser } from '../../services/userService';
import { AuthedRequest } from '../middleware/auth';
import { resolveAuthUserId } from '../utils/authUser';

const router = Router();

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  const telegramId = resolveAuthUserId(req);
  return getOrCreateUser(telegramId);
}

router.get('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  const categories = await listCategories(user.id);

  const unique = Array.from(
    new Map(categories.map((cat) => [cat.normalizedName, cat.name])).values(),
  );

  return res.json({ items: unique });
});

export default router;
