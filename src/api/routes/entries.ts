import { Router } from 'express';

import { ApiError } from '../../errors/ApiError';
import {
  entriesCreateBodySchema,
  entriesListQuerySchema,
  entriesUpdateBodySchema,
  entryIdParamSchema,
} from '../validators/entries';
import {
  createManualEntry,
  deleteUserEntry,
  getUserEntryById,
  listUserEntries,
  updateManualEntry,
} from '../../services/entriesService';
import { AuthedRequest } from '../middleware/auth';

const router = Router();

function requireUser(req: AuthedRequest) {
  if (!req.user) {
    throw new ApiError('Unauthorized', { statusCode: 401, code: 'UNAUTHORIZED' });
  }
  return req.user;
}

router.get('/', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const query = entriesListQuerySchema.parse(req.query);
  const result = await listUserEntries({ userId: user.id, ...query });
  return res.json(result);
});

router.get('/:id', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const { id } = entryIdParamSchema.parse(req.params);
  const entry = await getUserEntryById(user.id, id);
  return res.json(entry);
});

router.post('/', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const payload = entriesCreateBodySchema.parse(req.body);
  const created = await createManualEntry(user.id, payload);
  return res.status(201).json(created);
});

router.put('/:id', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const { id } = entryIdParamSchema.parse(req.params);
  const payload = entriesUpdateBodySchema.parse(req.body);
  const updated = await updateManualEntry(user.id, id, payload);
  return res.json(updated);
});

router.delete('/:id', async (req: AuthedRequest, res) => {
  const user = requireUser(req);
  const { id } = entryIdParamSchema.parse(req.params);
  await deleteUserEntry(user.id, id);
  return res.status(204).send();
});

export default router;
