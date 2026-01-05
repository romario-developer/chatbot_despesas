# Chatbot de Despesas (Telegram + Prisma + Postgres)

Bot em Node.js/TypeScript para registrar despesas via Telegram (grammY) e uma API REST para consumo por um PWA. Banco em Postgres com Prisma.

## Requisitos
- Node.js 20+
- npm
- Postgres (ou SQLite apenas para desenvolvimento local, ajustando `DATABASE_URL`)

## Variaveis de ambiente
- `BOT_TOKEN`: token do bot no BotFather.
- `DATABASE_URL`: URL do Postgres (ex.: `postgresql://user:pass@host:5432/db`).
- `ADMIN_PASSWORD`: senha unica para login na API.
- `JWT_SECRET`: segredo para assinar os JWTs da API.
- `PWA_ORIGIN`: origem permitida para CORS (ex.: `https://despesas-pwa.onrender.com`).
- `PORT`: porta HTTP (padrao 3000).
- `NODE_ENV`: `development` ou `production`.
- `USE_WEBHOOK`: `true` para webhook, `false` para polling local.
- `WEBHOOK_URL`: URL publica para registrar webhook (se nao usar `RENDER_EXTERNAL_URL`).

## Configuracao rapida
1. Instale dependencias:
   ```bash
   npm install
   ```
2. Crie `.env` a partir de `.env.example`:
   ```env
   BOT_TOKEN=<token do BotFather>
   DATABASE_URL=<sua URL do Postgres>
   ADMIN_PASSWORD=<senha para login na API>
   JWT_SECRET=<segredo forte>
   PWA_ORIGIN=https://despesas-pwa.onrender.com
   PORT=3000
   NODE_ENV=development
   USE_WEBHOOK=false
   WEBHOOK_URL=
   ```
3. Rode as migracoes e gere o client Prisma:
   ```bash
   npm run prisma:migrate
   ```
4. Executar:
   - Desenvolvimento (polling): `npm run dev`
   - Producao (build + start): `npm run build && npm start`
   - Healthcheck: `GET /health`

### Webhook (Render)
- Render expoe `RENDER_EXTERNAL_URL`; se quiser sobrescrever, defina `WEBHOOK_URL`.
- Com `USE_WEBHOOK=true`, o app registra webhook em `/webhook`.

## API REST (/api)
- Autenticacao: Bearer token (JWT). Obtenha via `POST /api/auth/login` enviando `{ "password": "<ADMIN_PASSWORD>" }`. Token expira em 7 dias.
- CORS: apenas `PWA_ORIGIN` (e `http://localhost:5173` em desenvolvimento) sao aceitos.
- Modelagem: reutiliza `Expense` (Prisma). Valores sao armazenados em centavos; a API expoe `amount` como numero decimal.

### Endpoints
- `POST /api/auth/login` - retorna `{ token }`.
- `GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&category=...&q=...` - lista, ordenada por `date` desc.
- `POST /api/entries` - body `{ amount, description, category, date: "YYYY-MM-DD" }`.
- `PUT /api/entries/:id` - body parcial (amount/description/category/date).
- `DELETE /api/entries/:id`
- `GET /api/categories` - lista unica de categorias.
- `GET /api/summary?month=YYYY-MM` - `total`, `totalPorCategoria`, `totalPorDia` do mes.

### Exemplos (curl)
```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"<ADMIN_PASSWORD>"}'

# Listar lancamentos (token de login em $TOKEN)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/entries?from=2025-01-01&to=2025-01-31"

# Criar lancamento
curl -X POST http://localhost:3000/api/entries \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":120.5,"description":"Mercado","category":"Supermercado","date":"2025-01-05"}'

# Atualizar lancamento
curl -X PUT http://localhost:3000/api/entries/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"category":"Alimentacao"}'

# Resumo do mes
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/summary?month=2025-01"
```

## Telegram (bot)
- Crie o bot com o BotFather e defina `BOT_TOKEN`.
- Fluxo: usuario envia mensagem com valor/data/categoria; o bot cria rascunho, permite confirmar/editar/cancelar.
- Comandos principais: `/start`, `/ajuda`, `/relatorio mes`, `/relatorio MM/AAAA`, `/categorias`, `/editar`, `/remover`.

## Reset total (perigoso)
- Use `/reset_total` para iniciar. O bot nao apaga nada ainda; gera um token curto, grava na sessao por 5 minutos e responde pedindo o texto `RESET <token>` e um botao inline "Cancelar".
- Ao receber `RESET <token>`, valida token e expiracao para o proprio `telegram_id`, apaga todas as despesas, rascunhos e categorias em transacao, recria a categoria padrão "Outros" e limpa a sessao.
- Tokens invalidos ou expirados sao recusados; rode `/reset_total` novamente para um novo desafio. O botao "Cancelar" remove o token sem apagar nada.
- Nao ha endpoint HTTP para reset e o filtro sempre e por usuario (multiusuario seguro).

## Backup / Reset / Restore (CLI)
- Backup (gera JSON em `backups/backup-YYYYMMDDTHHMM.json`):
  ```bash
  npm run db:backup
  ```
- Backup (Render, usando build/dist):
  ```bash
  npm run db:backup:render
  ```
- Reset (apaga dados transacionais; em producao exige `RESET_CONFIRM=YES`):
  ```bash
  RESET_CONFIRM=YES npm run db:reset
  ```
- Restore (reimporta um backup para um banco vazio; rode reset antes):
  ```bash
  npm run db:restore -- --file backups/backup-YYYYMMDDTHHMM.json
  ```
- O backup inclui usuarios, categorias, despesas, rascunhos, planejamento, sessoes e codigos de link do Telegram. O restore preserva IDs e reajusta sequences.
- Endpoint temporario para admin (requer `ADMIN_TOKEN`):
  ```http
  GET /api/admin/backup   (Authorization: Bearer <ADMIN_TOKEN>)
  ```
  Retorna o JSON do backup e loga o caminho do arquivo salvo (padrao `/tmp/backups` no Render). Use apenas para extração segura.

### Admin temporario: migrar dados de usuario

Endpoint temporario para consolidar dados de um usuario antigo (ex.: `admin`) para o usuario atual (ex.: `api-admin`). Requer `ADMIN_TOKEN` configurado.

- `POST /api/admin/migrate-user-data`
- Header: `x-admin-token: <ADMIN_TOKEN>`
- Body JSON:
  ```json
  {
    "oldTelegramId": "admin",
    "newTelegramId": "api-admin"
  }
  ```
- Resposta (exemplo):
  ```json
  {
    "movedEntries": 12,
    "movedDrafts": 0,
    "movedCategories": 3,
    "movedPlanning": 1,
    "movedSessions": 1,
    "oldUserId": 1,
    "newUserId": 2
  }
  ```

Exemplo curl (Insomnia similar):
```
curl -X POST https://<host>/api/admin/migrate-user-data \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"oldTelegramId":"admin","newTelegramId":"api-admin"}'
```

// Remover este endpoint apos concluir a migracao.

### Admin temporario: listar usuarios e migrar por ID

- `GET /api/admin/users/with-counts`
  - Header: `x-admin-token: <ADMIN_TOKEN>`
  - Retorna lista de usuarios com contagens `{ id, telegramId, createdAt, entriesCount, planningCount }` ordenada por `entriesCount` desc.

- `POST /api/admin/migrate-user-data-by-userid`
  - Header: `x-admin-token: <ADMIN_TOKEN>`
  - Body:
    ```json
    {
      "oldUserId": 1,
      "newTelegramId": "api-admin"
    }
    ```
  - Usa `oldUserId` conhecido e migra para o usuario resolvido por `newTelegramId` (create se nao existir). Resposta traz contagens movidas.

## Notas
- Fuso horario: `America/Bahia` para parsing e formatacao.
- Categorias sao por usuario (cada `telegram_id` tem suas categorias). A API cria/usa um usuario interno `api-admin` para lancamentos manuais.
- Deploy no Render usa `npm run start:render` (faz `prisma migrate deploy` antes de subir o servidor).
