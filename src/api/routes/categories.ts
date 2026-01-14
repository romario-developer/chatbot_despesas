import { Router } from 'express';

import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../../services/categoryService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

async function resolveUser(req: AuthedRequest) {
  if (req.user) return req.user;
  return null;
}

function parseActiveParam(value: unknown) {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'all') return undefined;
  return true;
}

router.get('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const active = parseActiveParam(req.query.active);
  const categories = await listCategories(
    user.id,
    typeof active === 'boolean' ? { active } : undefined,
  );

  return res.json({ items: categories });
});

router.post('/', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Nome invalido (minimo 2 caracteres)' });
  }

  const result = await createCategory(user.id, name);
  if ('conflict' in result) {
    return res.status(409).json({ error: 'Categoria ja existe', existing: result.conflict });
  }

  return res.status(201).json({ category: result.category });
});

router.patch('/:id', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  const updates: { name?: string; isActive?: boolean } = {};
  if (typeof req.body?.name === 'string') {
    updates.name = req.body.name.trim();
  }
  if (typeof req.body?.isActive === 'boolean') {
    updates.isActive = req.body.isActive;
  }

  if (!updates.name && typeof updates.isActive === 'undefined') {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  const result = await updateCategory(user.id, id, updates);
  if (!result) {
    return res.status(404).json({ error: 'Categoria nao encontrada' });
  }
  if ('conflict' in result) {
    return res.status(409).json({ error: 'Categoria ja existe', existing: result.conflict });
  }
  return res.json({ category: result });
});

router.delete('/:id', async (req: AuthedRequest, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID invalido' });
  }

  const result = await deleteCategory(user.id, id);
  if (!result) {
    return res.status(404).json({ error: 'Categoria nao encontrada' });
  }
  if ('inUse' in result && result.inUse) {
    return res.status(409).json({
      error: 'Categoria em uso. Desative-a em vez de excluir.',
      usage: result.count,
    });
  }
  return res.status(204).send();
});

export default router;
