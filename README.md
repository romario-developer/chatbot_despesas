# Chat Despesas API (Prisma + Postgres)

Backend API em Node.js/TypeScript usado exclusivamente pela PWA do Chat Despesas. Expõe rotas protegidas por JWT, organiza dados via Prisma e persiste em Postgres, mantendo os fluxos de autenticação, lançamentos, planejamento e dashboards que o frontend consome.

## Requisitos
- Node.js 20+
- npm
- Postgres (ou SQLite apenas para desenvolvimento local, ajustando `DATABASE_URL`)

## Variáveis de ambiente
- `DATABASE_URL`: URL do Postgres (ex.: `postgresql://user:pass@host:5432/db`).
- `ADMIN_EMAIL`: email do administrador que será criado pelo seed.
- `ADMIN_PASSWORD`: senha única para login na API e para o usuário admin do seed.
- `ADMIN_NAME`: nome exibido do admin (opcional; padrão `Admin`).
- `ADMIN_ROLE`: papel utilizado pelo seed apenas para fins de log (opcional; padrão `admin`).
- `BCRYPT_ROUNDS`: custo do hash bcrypt (opcional; padrão `10`).
- `JWT_SECRET`: segredo para assinar os JWTs da API.
- `PWA_ORIGIN`: origem permitida para CORS (ex.: `https://despesas-pwa.onrender.com`).
- `PORT`: porta HTTP (padrão 3000).
- `NODE_ENV`: `development` ou `production`.

## Configuração rápida
1. Instale dependências:
   ```bash
   npm install
   ```
2. Crie `.env` com as variáveis obrigatórias:
   ```env
   DATABASE_URL=<sua URL do Postgres>
   ADMIN_PASSWORD=<senha para login na API>
   JWT_SECRET=<segredo forte>
   PWA_ORIGIN=https://despesas-pwa.onrender.com
   PORT=3000
   NODE_ENV=development
   ```
3. Rode as migrações e gere o client Prisma:
   ```bash
   npm run prisma:migrate
   ```
4. Execute o backend:
   - Desenvolvimento: `npm run dev`
   - Produção: `npm run build && npm start`
   - Healthcheck: `GET /health`

## Seed do admin

- Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` (e opcionalmente `ADMIN_NAME`, `ADMIN_ROLE`, `BCRYPT_ROUNDS`) no `.env` ou no ambiente.
- Execute:
  ```bash
  npx prisma db seed
  ```
- O seed usa `tsx prisma/seed.ts` e garante que o usuário admin com `telegramId` igual a `admin` exista sem duplicar.

## API REST (/api)
- Autenticação: Bearer token (JWT). Obtenha via `POST /api/auth/login` enviando `{ "password": "<ADMIN_PASSWORD>" }`. Token expira em 7 dias.
- CORS: apenas `PWA_ORIGIN` (e `http://localhost:5173` em desenvolvimento) são aceitos.
- Modelagem: valores são armazenados em centavos (`amountCents`); o front entrega/consome montantes em reais. Categorias, cartões, créditos, planejamento e relatórios estão ligados ao usuário autenticado.
- Rotas adicionais usadas pelo PWA: `/api/dashboard`, `/api/cards`, `/api/credits`, `/api/assistant`, `/api/planning`, `/api/reports`, `/api/quick-entry`, `/api/me` e `/api/admin/exports/expenses.csv`.

### Assistente Inteligente (/api/assistant/chat)
- Um único endpoint que responde saudações, entradas rápidas de gastos (“mercado 50”) e perguntas sobre saldo, faturas ou planejamento sem depender de IA externa.
- `POST /api/assistant/chat` aceita `{ message, month?: "YYYY-MM", conversationId?: string }` e sempre devolve `assistantMessage`, `cards`, `suggestedActions` e um `state` com o mês ou `null`.
- Quando detectar texto de lançamento valida e registra usando o parser do quick-entry, o retorno confirma o gasto e sugere ações como “Editar categoria” ou “Desfazer”; caso contrário, responde com cards baseados em dashboard, categorias, faturas e planejamento reais.

### Endpoints principais
- `POST /api/auth/login` - retorna `{ token }`.
- `GET /api/entries?from=YYYY-MM-DD&to=YYYY-MM-DD&category=...&q=...` - lista lançamentos (ordenados por `date` desc).
- `POST /api/entries` - body `{ amount, description, category, date: "YYYY-MM-DD" }`.
- `PUT /api/entries/:id` - body parcial (amount/description/category/date).
- `DELETE /api/entries/:id`
- `GET /api/categories` - lista única de categorias por usuário.
- `GET /api/summary?month=YYYY-MM` - retorna `total`, `totalPorCategoria` e `totalPorDia` do mês.

### Exemplos (curl)
```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"<ADMIN_PASSWORD>"}'

# Listar lançamentos (token de login em $TOKEN)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/entries?from=2025-01-01&to=2025-01-31"

# Criar lançamento
curl -X POST http://localhost:3000/api/entries \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":120.5,"description":"Mercado","category":"Supermercado","date":"2025-01-05"}'

# Atualizar lançamento
curl -X PUT http://localhost:3000/api/entries/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"category":"Alimentacao"}'

# Resumo do mês
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/summary?month=2025-01"
```

### Export CSV (Admin)
- Endpoint protegido por `x-admin-token: <ADMIN_TOKEN>`.
- `GET /api/admin/exports/expenses.csv?month=YYYY-MM&from=YYYY-MM-DD&to=YYYY-MM-DD&source=...&category=...`
  - `month` é preferencial; se presente ignora `from/to`.
  - `source`/`category` são opcionais (filtro `contains`, case-insensitive).
  - Exporta linhas com `date,description,category,amount,source` (data `YYYY-MM-DD`, amount em reais).

## Backup / Reset / Restore (CLI)
- Backup (gera JSON em `backups/backup-YYYYMMDDTHHMM.json`):
  ```bash
  npm run db:backup
  ```
- Backup no Render (usa build/dist):
  ```bash
  npm run db:backup:render
  ```
- Reset (apaga dados transacionais; em produção exige `RESET_CONFIRM=YES`):
  ```bash
  RESET_CONFIRM=YES npm run db:reset
  ```
- Restore (reimporta backup em esquema limpo; rode reset antes):
  ```bash
  npm run db:restore -- --file backups/backup-YYYYMMDDTHHMM.json
  ```
- O backup inclui usuários, categorias, despesas, rascunhos, planejamento, sessoes e eventuais códigos legados.

## Notas
- Fuso horário fixo: `America/Bahia` para parsing e formatação.
- Categorias, cartões e créditos são separados por usuário (a API gera/usa um usuário interno `api-admin` para lançamentos manuais quando necessário).
- O backend serve exclusivamente o PWA, mantendo CORS restrito a `PWA_ORIGIN`.
