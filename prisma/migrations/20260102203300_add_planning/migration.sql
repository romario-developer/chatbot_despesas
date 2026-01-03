-- CreateTable
CREATE TABLE "Planning" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Planning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Planning_userId_key" ON "Planning"("userId");

-- AddForeignKey
ALTER TABLE "Planning" ADD CONSTRAINT "Planning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
