DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'BackupAction'
  ) THEN
    CREATE TYPE "BackupAction" AS ENUM ('create', 'update', 'delete');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BackupEvent" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "action" "BackupAction" NOT NULL,
  "entityId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "BackupEvent_userId_idx" ON "BackupEvent"("userId");
CREATE INDEX IF NOT EXISTS "BackupEvent_entity_idx" ON "BackupEvent"("entity", "entityId");
CREATE INDEX IF NOT EXISTS "BackupEvent_createdAt_idx" ON "BackupEvent"("createdAt");
