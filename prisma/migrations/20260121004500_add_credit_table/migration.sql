-- Create the Credit table needed by the Prisma schema.
CREATE TABLE "Credit" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Credit_userId_createdAt_idx" ON "Credit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Credit_userId_updatedAt_idx" ON "Credit"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Credit" ADD CONSTRAINT "Credit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
