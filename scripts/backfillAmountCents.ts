import { prisma } from "../src/db/prisma";

async function columnExists(table: string, column: string) {
  const result = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE lower(table_name) = lower(${table})
        AND lower(column_name) = lower(${column})
    ) AS "exists";
  `;
  return Boolean(result[0]?.exists);
}

async function countMissingAmountCents() {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Expense"
    WHERE "amountCents" IS NULL
  `;
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const hasAmountCents = await columnExists("Expense", "amountCents");
  if (!hasAmountCents) {
    throw new Error('[backfill] coluna "amountCents" nao encontrada na tabela Expense.');
  }

  const hasAmount = await columnExists("Expense", "amount");
  if (!hasAmount) {
    console.log('[backfill] coluna "amount" nao encontrada; nada para corrigir.');
    return;
  }

  const pendingRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Expense"
    WHERE "amountCents" IS NULL
      AND "amount" IS NOT NULL
  `;
  const missingCount = Number(pendingRows[0]?.count ?? 0);
  console.log(`[backfill] registros com amountCents nulo e amount preenchido: ${missingCount}`);

  if (!missingCount) {
    console.log("[backfill] nada a corrigir.");
    return;
  }

  const updated = await prisma.$executeRawUnsafe(
    'UPDATE "Expense" SET "amountCents" = CAST(ROUND("amount" * 100) AS INTEGER) WHERE "amountCents" IS NULL AND "amount" IS NOT NULL',
  );

  console.log(`[backfill] linhas atualizadas: ${updated}`);

  const remaining = await countMissingAmountCents();
  if (remaining > 0) {
    console.warn(`[backfill] ainda restam ${remaining} registros sem amountCents. Verifique manualmente.`);
  } else {
    console.log("[backfill] concluido. Todos os registros possuem amountCents.");
  }
}

main()
  .catch((err) => {
    console.error("[backfill] falhou:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
