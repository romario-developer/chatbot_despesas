import { Router } from 'express';

import { authMiddleware, AuthedRequest } from '../api/middleware/auth';
import requireDb from '../middlewares/requireDb';
import { buildUserBackup, restoreUserBackup } from '../services/userBackupService';

const router = Router();

router.use(authMiddleware);
router.use(requireDb);

router.get('/export', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const snapshot = await buildUserBackup(userId, process.env.APP_ENV?.trim() || 'development');
    return res.json(snapshot);
  } catch (error) {
    console.error('[user/backup/export] erro:', error);
    return res.status(500).json({ error: 'Erro ao gerar backup' });
  }
});

router.post('/import', async (req: AuthedRequest, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  if (
    !payload ||
    !payload.meta ||
    payload.meta.userId !== userId ||
    !payload.data ||
    typeof payload.meta.version !== 'number'
  ) {
    return res.status(400).json({ error: 'Backup inválido' });
  }

  try {
    const counts = await restoreUserBackup(userId, payload.data);
    return res.json({
      ok: true,
      importedAt: new Date().toISOString(),
      counts,
    });
  } catch (error) {
    console.error('[user/backup/import] erro:', error);
    return res.status(500).json({ error: 'Falha ao importar backup' });
  }
});

export default router;
