-- AlterTable
ALTER TABLE "UserSession" ADD COLUMN "resetToken" TEXT;
ALTER TABLE "UserSession" ADD COLUMN "resetTokenExpiresAt" TIMESTAMP(3);
