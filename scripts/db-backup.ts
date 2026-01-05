import { prisma } from "../src/db/prisma";
import { runBackup } from "../src/services/backupService";

async function main() {
  const { filePath, payload } = await runBackup();
  console.log("[backup] salvo em", filePath);
  console.log("[backup] contagens:", payload.meta.counts);
}

main()
  .catch((err) => {
    console.error("[backup] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
