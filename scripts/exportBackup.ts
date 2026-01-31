import fs from "fs";
import path from "path";

import { exportSnapshot, type BackupFilters } from "../src/services/backupService";
import { prisma } from "../src/infra/db/prisma";

function parseCliFilters(): { filters: BackupFilters; output?: string } {
  const raw = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  raw.forEach((arg) => {
    if (!arg.startsWith("--")) return;
    const [key, value] = arg.slice(2).split("=");
    if (!key || !value) return;
    parsed[key] = value;
  });

  return {
    filters: {
      month: parsed.month,
      from: parsed.from,
      to: parsed.to,
    },
    output: parsed.output,
  };
}

async function main() {
  const { filters, output } = parseCliFilters();
  const snapshot = await exportSnapshot(filters);

  const dir = path.resolve(process.env.BACKUP_DIR || "backups");
  fs.mkdirSync(dir, { recursive: true });
  const fileName =
    output?.trim() ||
    `backup-export-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.json`;
  const filePath = path.join(dir, fileName);

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log("[backup:export] salvo em", filePath);
  console.log("[backup:export] filtros aplicados:", filters);
}

main()
  .catch((error) => {
    console.error("[backup:export] falhou:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
