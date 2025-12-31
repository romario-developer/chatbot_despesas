import { Router } from 'express';

import { prisma } from '../../db/prisma';

const router = Router();

router.get('/', async (_req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
  });

  const unique = Array.from(
    new Map(categories.map((cat) => [cat.normalizedName, cat.name])).values(),
  );

  return res.json({ items: unique });
});

export default router;
