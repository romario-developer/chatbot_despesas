-- 1) InstallmentGroup (tabela que estava faltando)
CREATE TABLE IF NOT EXISTS "InstallmentGroup" (
  "id" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cardId" INTEGER NOT NULL,
  "descriptionBase" TEXT NOT NULL,
  "totalAmountCents" INTEGER NOT NULL,
  "installmentsTotal" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "InstallmentGroup"
  ADD CONSTRAINT "InstallmentGroup_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstallmentGroup"
  ADD CONSTRAINT "InstallmentGroup_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "Card"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "InstallmentGroup_userId_cardId_idx"
  ON "InstallmentGroup"("userId", "cardId");

-- 2) CardPayment (tabela que estava faltando)
CREATE TABLE IF NOT EXISTS "CardPayment" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cardId" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "paymentDate" TIMESTAMP(3) NOT NULL,
  "cycleEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "CardPayment"
  ADD CONSTRAINT "CardPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CardPayment"
  ADD CONSTRAINT "CardPayment_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "Card"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "CardPayment_userId_cardId_cycleEnd_idx"
  ON "CardPayment"("userId", "cardId", "cycleEnd");

-- 3) Expense: colunas de parcelas + FK para InstallmentGroup
ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "installmentGroupId" TEXT;

ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "installmentIndex" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "installmentsTotal" INTEGER NOT NULL DEFAULT 1;

-- FK (opcional, pois installmentGroupId é nullable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Expense_installmentGroupId_fkey'
  ) THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_installmentGroupId_fkey"
      FOREIGN KEY ("installmentGroupId") REFERENCES "InstallmentGroup"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Expense_installmentGroupId_idx"
  ON "Expense"("installmentGroupId");
