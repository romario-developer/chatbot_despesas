import { Router } from 'express';

import { prisma } from '../../infra/db/prisma';
import { uploadUserBackupToGithub } from '../../services/githubBackupService';
import { buildUserBackup } from '../../services/userBackupService';
import requireDb from '../../middlewares/requireDb';

const BACKUP_CRON_SECRET = process.env.BACKUP_CRON_SECRET;
const APP_ENV = process.env.APP_ENV?.trim() || 'development';

const router = Router();

router.use(requireDb);

router.post('/backup/run', async (req, res) => {
  if (!BACKUP_CRON_SECRET) {
    return res.status(503).json({ error: 'BACKUP_CRON_SECRET nao configurado' });
  }

  const secret =
    typeof req.headers['x-backup-secret'] === 'string' ? req.headers['x-backup-secret'].trim() : '';
  if (!secret || secret !== BACKUP_CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const results: { userId: number; error?: string }[] = [];

  for (const user of users) {
    try {
      const snapshot = await buildUserBackup(user.id, APP_ENV);
      await uploadUserBackupToGithub(user.id, snapshot);
      results.push({ userId: user.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      results.push({ userId: user.id, error: message });
    }
  }

  const success = results.filter((r) => !r.error).length;
  const failed = results.length - success;

  return res.json({
    totalUsers: results.length,
    success,
    failed,
    errors: results.filter((r) => r.error).map((r) => ({ userId: r.userId, message: r.error })),
  });
});

export default router;
