-- CategoryRule
CREATE TABLE IF NOT EXISTS "CategoryRule" (
  "id" SERIAL PRIMARY KEY,
  "categoryId" INTEGER NOT NULL,
  "keywords" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CategoryRule_categoryId_fkey') THEN
    ALTER TABLE "CategoryRule"
      ADD CONSTRAINT "CategoryRule_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CategoryRule_categoryId_idx" ON "CategoryRule" ("categoryId");

-- CategoryMemory
CREATE TABLE IF NOT EXISTS "CategoryMemory" (
  "id" SERIAL PRIMARY KEY,
  "normalizedText" TEXT NOT NULL,
  "categoryId" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CategoryMemory_categoryId_fkey') THEN
    ALTER TABLE "CategoryMemory"
      ADD CONSTRAINT "CategoryMemory_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CategoryMemory_normalizedText_key" ON "CategoryMemory" ("normalizedText");

-- Expense categorySource
ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "categorySource" TEXT;

-- Category flags
ALTER TABLE "Category"
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
