import { prisma } from '../db/prisma';

export async function getAssistantActionLog(conversationId: string) {
  if (!conversationId) return null;
  return prisma.assistantActionLog.findUnique({
    where: { conversationId },
  });
}

export async function upsertAssistantActionLog(conversationId: string, entity: string, entityId: number) {
  return prisma.assistantActionLog.upsert({
    where: { conversationId },
    update: { lastEntity: entity, lastEntityId: entityId },
    create: { conversationId, lastEntity: entity, lastEntityId: entityId },
  });
}

export async function deleteAssistantActionLog(conversationId: string) {
  return prisma.assistantActionLog.deleteMany({
    where: { conversationId },
  });
}
