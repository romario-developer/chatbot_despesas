import type { BackupAction, Prisma } from '@prisma/client';

import { prisma } from '../infra/db/prisma';

export type BackupEventPayload = {
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  updatedFields?: string[];
};

export async function createBackupEvent(payload: {
  userId: number;
  entity: string;
  entityId?: string | number;
  action: BackupAction;
  payload: BackupEventPayload;
}) {
  const { userId, entity, entityId, action } = payload;
  const { before, after, updatedFields } = payload.payload;
  const jsonPayload = {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(updatedFields !== undefined ? { updatedFields } : {}),
  } as Prisma.InputJsonObject;

  await prisma.backupEvent.create({
    data: {
      userId: String(userId),
      entity,
      entityId: entityId?.toString(),
      action,
      payload: jsonPayload,
    },
  });
}
