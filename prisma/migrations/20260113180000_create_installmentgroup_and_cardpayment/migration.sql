-- InstallmentGroup
CREATE TABLE IF NOT EXISTS "InstallmentGroup" (
  "id" TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cardId" INTEGER NOT NULL,
  "descriptionBase" TEXT NOT NULL,
  "totalAmountCents" INTEGER NOT NULL,
  "installmentsTotal" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstallmentGroup_userId_fkey') THEN
    ALTER TABLE "InstallmentGroup"
      ADD CONSTRAINT "InstallmentGroup_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InstallmentGroup_cardId_fkey') THEN
    ALTER TABLE "InstallmentGroup"
      ADD CONSTRAINT "InstallmentGroup_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "Card"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- CardPayment
CREATE TABLE IF NOT EXISTS "CardPayment" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "cardId" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "paymentDate" TIMESTAMP(3) NOT NULL,
  "cycleEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CardPayment_userId_fkey') THEN
    ALTER TABLE "CardPayment"
      ADD CONSTRAINT "CardPayment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CardPayment_cardId_fkey') THEN
    ALTER TABLE "CardPayment"
      ADD CONSTRAINT "CardPayment_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "Card"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Expense: parcelas
ALTER TABLE "Expense"
  ADD COLUMN IF NOT EXISTS "installmentGroupId" TEXT,
  ADD COLUMN IF NOT EXISTS "installmentIndex" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "installmentsTotal" INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_installmentGroupId_fkey') THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_installmentGroupId_fkey"
      FOREIGN KEY ("installmentGroupId") REFERENCES "InstallmentGroup"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
