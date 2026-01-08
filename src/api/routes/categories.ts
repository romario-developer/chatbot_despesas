import { Router } from 'express';

import { listCategories } from '../../services/categoryService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  return null;
}

router.get('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const categories = await listCategories(user.id);

  const unique = Array.from(
    new Map(categories.map((cat) => [cat.normalizedName, cat.name])).values(),
  );

  return res.json({ items: unique });
});

export default router;
