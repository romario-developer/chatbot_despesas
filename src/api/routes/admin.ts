import { Router } from "express";

import { runBackup } from "../../services/backupService";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn("[admin] ADMIN_TOKEN não definido; /api/admin/backup ficará inativo.");
}

const router = Router();

router.get("/backup", async (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN não configurado" });
  }

  const auth = req.headers.authorization;
  const token = auth?.replace(/^Bearer /i, "").trim();
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { filePath, payload } = await runBackup();
    console.log("[admin][backup] gerado em", filePath, "contagens:", payload.meta.counts);

    res.setHeader("Content-Disposition", `attachment; filename=${filePath.split("/").pop()}`);
    return res.json(payload);
  } catch (err) {
    console.error("[admin][backup] falhou:", err);
    return res.status(500).json({ error: "Falha ao gerar backup" });
  }
});

export default router;
