# Documentacao Tecnica Completa - Backend Chat Despesas

Atualizado em: 2026-03-01
Escopo: estado real do codigo em `src/`, `prisma/` e `scripts/`.

## 1) Visao Geral

Backend HTTP em Node.js + TypeScript com Express e Prisma (Postgres), focado no ecossistema Chat Despesas.

Responsabilidades principais:
- Autenticacao JWT para usuarios da PWA.
- CRUD de lancamentos financeiros (com suporte a cartao e parcelas).
- Planejamento mensal (salario, extras, contas fixas).
- Dashboards, resumos e relatorios mensais.
- Modulo de assistente para registrar gastos por linguagem natural.
- Modulo de insights (`/api/ai/chat`) baseado em ferramentas internas.
- Backups administrativos e backup por usuario (incluindo export/import).

## 2) Stack e Dependencias

- Runtime: Node.js (CommonJS)
- Linguagem: TypeScript
- HTTP: Express 5
- ORM: Prisma
- Banco: PostgreSQL
- Auth: JWT (`jsonwebtoken`)
- Hash de senha: `bcryptjs`
- Validacao: `zod`
- Datas: `dayjs` com timezone
- IA/SDK: pacote `openai` (em codigo atual, o endpoint `/api/ai/chat` usa ferramentas internas)

Scripts de pacote (`package.json`) relevantes:
- `npm run dev`: `tsx watch src/index.ts`
- `npm run build`: `tsc -p tsconfig.json` (com `prebuild = prisma generate`)
- `npm start`: `node dist/src/index.js`
- `npm test`: testes de parser/planning e dinheiro
- Scripts DB/backup/migracao: ver secao 12

## 3) Arquitetura de Pastas

- `src/index.ts`: bootstrap do servidor, CORS, JSON parser, montagens e shutdown.
- `src/api/`: rotas REST principais e middlewares API.
- `src/routes/`: rotas fora do roteador API principal (`/health`, `/api/user/backup`).
- `src/services/`: regras de negocio e orquestracao de dados.
- `src/domain/`: parsers e regras de dominio (quick-entry, parcelas, ciclos).
- `src/utils/`: utilitarios (dinheiro, datas, normalizacao, etc).
- `src/infra/db/`: client Prisma e estado de disponibilidade do DB.
- `prisma/`: schema, seed e migrations.
- `scripts/`: operacoes manuais de backup/reset/restore/migracoes.

## 4) Inicializacao e Ciclo de Vida

Fluxo (`src/index.ts`):
1. Carrega `.env` e define `process.env.TZ = 'America/Fortaleza'`.
2. Exige `PWA_ORIGIN`.
3. Configura CORS com allowlist:
   - `https://despesas-pwa.onrender.com`
   - `https://chatbot-despesas-pwa.onrender.com`
   - `http://localhost:5173`
   - `http://localhost:3000`
   - `PWA_ORIGIN` do ambiente
4. Monta rotas:
   - `/api/user/backup` (router proprio)
   - `/api/health`
   - `/api/*` (router principal)
5. Tenta conectar no banco com retry:
   - max 15 tentativas
   - backoff 500ms -> 10s
   - se esgotar, sobe em modo degradado (DB indisponivel)
6. `SIGTERM`/`SIGINT`: desconecta Prisma e encerra.

Estado do banco:
- `src/infra/db/dbState.ts` guarda `ready`, `lastError`, `lastOkAt`.
- Middleware `requireDb` responde 503 com `DB_UNAVAILABLE` quando banco nao esta pronto.

## 5) Timezone e Dinheiro

Regras de tempo e moeda:
- Dominio de datas usa timezone `America/Bahia` em utilitarios (`src/utils/dates.ts`).
- Valores monetarios sao persistidos em centavos (`amountCents`, `limit`, etc).
- Conversoes em `src/utils/money.ts`:
  - `toAmountCents`
  - `centsToNumber`
  - validacoes e formatadores.

Observacao tecnica importante:
- Existe diferenca entre timezone do processo (`America/Fortaleza`) e timezone utilitario (`America/Bahia`). Em pratica sao fusos equivalentes no contexto atual, mas e um ponto de consistencia para manter monitorado.

## 6) Seguranca e Autenticacao

### JWT
- Middleware: `src/api/middleware/auth.ts`.
- Header obrigatorio: `Authorization: Bearer <token>`.
- Token valido com `JWT_SECRET`.
- `sub` do token e usado para localizar usuario (`findUserBySubject`).
- Sem usuario valido => 401.

### Login/Signup
- `POST /api/auth/signup`
  - cria usuario por email/senha.
  - senha minima: 8.
- `POST /api/auth/login`
  - fluxo 1: email+senha de usuario.
  - fluxo 2: senha admin (`ADMIN_PASSWORD`) sem email -> usuario admin.
- Expiracao JWT: 7 dias.

### Admin token
- Rotas `/api/admin/*` usam `ADMIN_TOKEN`.
- Aceita:
  - `x-admin-token`
  - ou `Authorization: Bearer <ADMIN_TOKEN>`
- `POST /api/admin/users` usa header especifico `x-admin-secret`.

### Secret interno de backup
- `POST /api/internal/backup/run` exige `x-backup-secret = BACKUP_CRON_SECRET`.

## 7) Modelo de Dados (Prisma)

Arquivo fonte: `prisma/schema.prisma`.

### Entidades centrais
- `User`
  - identidade e credenciais (`email`, `passwordHash`, `telegramId`)
  - relacoes com categorias, despesas, cartoes, planejamento etc.
- `Category`
  - unica por usuario via `@@unique([userId, normalizedName])`.
  - suporta regra (`CategoryRule`) e memoria (`CategoryMemory`).
- `Expense`
  - lancamento financeiro central.
  - campos: `amountCents`, `paymentMethod`, `cardId`, `invoiceMonth`, parcelas etc.
- `Card`
  - limite, bandeira, dia de fechamento e vencimento.
- `InstallmentGroup`
  - agrupa despesas parceladas.
- `CardPayment`
  - pagamentos de fatura por ciclo.
- `Planning`
  - JSON com planejamento mensal.
- `Credit`
  - receitas/creditos do usuario.
- `ExpenseDraft`, `UserSession`, `AssistantConversation`, `AssistantActionLog`
  - suporte a assistente e fluxo conversacional.
- `BackupEvent`
  - trilha de eventos de backup (create/update/delete).

### Enums
- `PaymentMethod`: `CASH|DEBIT|CREDIT|PIX|TRANSFER|OTHER`
- `BackupAction`: `create|update|delete`

## 8) Historico de Migracoes (alto nivel)

Diretorio: `prisma/migrations/`.

Evolucao registrada:
1. `20251231143117_init` (base inicial)
2. Planejamento e sessao reset (`20260102200500`, `20260102203300`)
3. Vinculos telegram e ajustes de usuario (`20260103012821`, `20260108023000`, `20260108123000`, `20260109093000`)
4. Modulo cartoes e cores (`20260110120000`, `20260112103000`, `20260112150000`)
5. Parcelamento e grupos (`20260113143000`, `20260113180000`, `20260115152000`)
6. Assistente (acao log, memory, conversation, stage) (`20260114120000`, `20260114124500`, `20260124000000`, `20260125000000`)
7. Campos de compra/fatura (`20260121000100`, `20260121003000`, `20260126000000`)
8. Tabela `Credit` (`20260121004500`)
9. BackupEvent (`20260206000000`)

## 9) Rotas HTTP - Mapa Completo

Base API: `/api`

### 9.1 Publicas (sem JWT)
- `GET /api/health`
  - status da aplicacao e ping DB.
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/internal/backup/run`
  - requer secret de cron, nao usa JWT.
- `GET /api/admin/backup`
- `GET /api/admin/backup/export`
- `GET /api/admin/backup/entries.csv`
- `GET /api/admin/exports/expenses.csv`
- `POST /api/admin/users`
  - com secret admin.

### 9.2 Protegidas (JWT + requireDb)

#### Entries
- `GET /api/entries`
  - filtros: `from`, `to`, `category`, `q`, `source`, `cardId`, `payment`, `paymentMethod`.
- `GET /api/entries/:id`
- `POST /api/entries`
  - `amount`, `description`, `date`, opcionais: `category`, `paymentMethod`, `cardId`, `installments`.
- `PUT /api/entries/:id`
- `DELETE /api/entries/:id`

Regras importantes:
- valores em centavos internamente.
- categoria pode ser inferida por regras/memoria quando nao enviada.
- parcelas > 1 geram N despesas vinculadas a `InstallmentGroup`.
- `paymentMethod=CREDIT` exige `cardId`.

#### Categories
- `GET /api/categories?active=true|false|all`
- `POST /api/categories`
- `PATCH /api/categories/:id`
- `DELETE /api/categories/:id`

#### Planning
- `GET /api/planning`
- `PUT /api/planning`
  - payload parcial:
    - `salaryByMonth`
    - `extrasByMonth`
    - `fixedBills`

#### Summary / Dashboard / Reports
- `GET /api/summary?month=YYYY-MM`
- `GET /api/dashboard/summary?month=YYYY-MM`
- `GET /api/reports/monthly-summary?month=YYYY-MM`

Diferencas:
- `summary`/`reports` usam `getMonthlySummary` (visao completa em centavos, incluindo credito/cartao).
- `dashboard/summary` agrega somente despesas nao credito (`paymentMethod != CREDIT`) para saldo em conta.

#### Cards
- `GET /api/cards`
- `POST /api/cards`
- `PUT /api/cards/:id`
- `DELETE /api/cards/:id`
- `GET /api/cards/summary`
- `GET /api/cards/invoices?month=YYYY-MM|asOf=YYYY-MM-DD`
- `GET /api/cards/invoices/open`
- `GET /api/cards/:cardId/invoices/:cycleEnd`
  - suporta `search`, `page`, `limit`, `sort`.
- `GET /api/cards/:cardId/invoice?month=YYYY-MM`
- `GET /api/cards/:cardId/invoice/summary?month=YYYY-MM`
- `GET /api/cards/:cardId/purchases?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/cards/payments`
  - `cardId`, `amount`, `paidAt`/`paymentDate`.

Regras de fatura:
- ciclo por `closingDay` (servico `cardCycle`).
- soma compras de credito no ciclo.
- subtrai `CardPayment` para obter `remaining`.
- status: `EMPTY|PAID|OPEN`.

#### Credits
- `GET /api/credits`
- `GET /api/credits/cards`
- `GET /api/credits/overview?month=YYYY-MM`
- `GET /api/credits/:id`
- `POST /api/credits`
- `PATCH /api/credits/:id`
- `DELETE /api/credits/:id`

#### Quick Entry
- `POST /api/quick-entry`
  - interpreta texto curto (`text`) e registra despesa.
  - detecta metodo de pagamento, parcelas, categoria e cartao.
  - cria lancamento unico ou grupo de parcelas.

#### Assistant (transacional)
- `POST /api/assistant/chat`

Capacidades:
- conversa orientada a estados (`ask_description`, `ask_amount`, `ask_payment`, `ask_card`, `confirming`, `saved`).
- pode registrar planejamento por mensagem.
- pode desfazer ultimo gasto da conversa (`desfazer`).
- retorna `state` + `uiHint` para frontend.

#### AI Insights
- `POST /api/ai/chat`

Capacidades:
- gera cards de insight com ferramentas internas:
  - dashboard
  - planejamento
  - top gastos
  - faturas abertas (quando pedido)
- pede clarificacao de mes quando pergunta for temporal e `month` nao vier.
- mantem historico em memoria por `conversationId` (volatil).

#### Usuario atual
- `POST /api/me/sample-data`
  - injeta dados de exemplo para onboarding.

#### Debug
- `GET /api/debug/whoami`

### 9.3 Rotas de backup por usuario (fora de `src/api/routes`)

Montagem em `src/index.ts`: `app.use('/api/user/backup', userBackupRouter)`

- `GET /api/user/backup/export`
- `POST /api/user/backup/import`

Regras:
- exige JWT.
- import valida `meta.userId` igual ao usuario autenticado.
- restore sobrescreve dados do usuario numa transacao.

## 10) Servicos de Negocio - O que existe hoje

### Financeiro
- `entriesService`: list/get/create/update/delete de lancamentos manuais.
- `expenseService`: operacoes de despesa usadas por assistente.
- `monthlySummaryService`: agregacoes mensais completas.
- `dashboardService`: resumo para dashboard com foco em saldo em conta.
- `reportService`: relatorios paginados e mensais.

### Categorias
- `categoryService`: CRUD e categoria padrao.
- `categoryClassifier` + `CategoryRule` + `CategoryMemory`: classificacao e aprendizado.

### Cartoes e parcelas
- `cardService`: resolucao/listagem de cartao.
- `cardCycle`: ciclo aberto e ciclo por mes.
- `installmentService`: cria N despesas parceladas, com `invoiceMonth` correto.

### Planejamento
- `planningService`:
  - versao de formato (`PLANNING_FORMAT_VERSION = 2`)
  - migracao automatica de dados antigos
  - normalizacao de payload e helpers de escrita

### Assistente
- `assistantConversationService`: estado e rascunho de conversa.
- `assistantExpenseParser`, `assistantPlanningParser`: parse de intencao.
- `assistantActionLogService`: log de ultima acao.
- `assistantChatService`/`assistantFallbackService`: suporte interpretativo.
- `aiToolService`: ferramentas de dados usadas por `/api/ai/chat`.

### Backup
- `backupService`: snapshot global e export filtrado.
- `userBackupService`: snapshot/restauracao por usuario.
- `githubBackupService`: upload JSON por usuario no GitHub Contents API.
- `backupEventService`: persistencia de eventos de alteracao.

## 11) Tratamento de Erros e Validacao

- Validacao de entrada via `zod` (rotas entries/planning/params e outros schemas locais).
- Classe `ApiError` padroniza `statusCode`, `code`, `details`.
- `errorHandler` converte:
  - `ZodError` -> 400 `VALIDATION_ERROR`
  - `ApiError` -> status/code especificos
  - fallback -> 500 `UNHANDLED_ERROR`
- Respostas de CORS bloqueado sao tratadas com 403.

## 12) Scripts Operacionais

### Banco e backup
- `npm run db:backup`
  - snapshot completo local.
- `npm run db:backup:render`
  - backup pelo build em `dist`.
- `npm run backup:export -- --month=YYYY-MM`
  - export filtrado para arquivo JSON.
- `npm run db:reset`
  - limpa dados transacionais (producao exige `RESET_CONFIRM=YES`).
- `npm run db:restore -- --file <json>`
  - restaura snapshot com validacao de banco vazio.
- `npm run db:backfill-amount-cents`
  - corrige dados legados de `amount -> amountCents`.

### Seed
- `npm run seed`
  - cria/atualiza admin com `ADMIN_EMAIL` + `ADMIN_PASSWORD`.
- `npm run seed:categories`
  - garante categorias padrao e regras por usuario.

### Migracoes manuais de dados
- `npm run db:migrate-user-data`
- `npm run db:migrate-telegram-admin`
- `npm run db:migrate-user-to-admin`
- `npm run db:migrate-all-to-admin`

### Utilitario de intervalo
- `npm run verify:date-range`

## 13) Variaveis de Ambiente

Obrigatorias para subir API com auth:
- `DATABASE_URL`
- `PWA_ORIGIN`
- `JWT_SECRET`
- `ADMIN_PASSWORD`

Fortemente recomendadas:
- `PORT`
- `NODE_ENV`
- `ADMIN_TOKEN` (rotas admin)
- `ADMIN_EMAIL` (seed)
- `ADMIN_NAME`
- `BCRYPT_ROUNDS`

Para backup GitHub:
- `GITHUB_BACKUP_TOKEN`
- `GITHUB_BACKUP_REPO`
- `GITHUB_BACKUP_BRANCH` (opcional, default `main`)
- `BACKUP_CRON_SECRET`
- `APP_ENV`

Outras de operacao/debug:
- `BACKUP_DIR`
- `DEBUG_ENTRIES`
- `DEBUG_DASHBOARD`
- `DEBUG_INVOICES`

## 14) Testes Atuais

Comando unico:
- `npm test`

Arquivos cobertos hoje:
- `src/services/assistantPlanningParser.test.ts`
- `src/utils/money.test.ts`

Observacao:
- suite atual cobre parser/planning e dinheiro; nao ha suite ampla de integracao HTTP no repositorio atual.

## 15) Pontos de Atencao Tecnica (estado atual)

1. Timezone definido em dois locais diferentes (`America/Fortaleza` e `America/Bahia`).
2. Endpoint `/api/ai/chat` usa historico em memoria local (`Map`), entao nao persiste entre reinicios/escala horizontal.
3. Parte do ecossistema ainda possui artefatos de legados Telegram em modelos/scripts, embora fluxo principal seja PWA.
4. Reset/restore sao operacoes fortes; usar sempre com backup previo.

## 16) Checklist de Operacao Rapida

1. Configurar `.env` com variaveis obrigatorias.
2. `npm install`.
3. `npm run prisma:migrate`.
4. (Opcional) `npm run seed`.
5. `npm run dev`.
6. Validar `GET /api/health`.
7. Fazer login em `POST /api/auth/login`.

## 17) Fluxos Especiais Ja Documentados no Repositorio

- Assistente: `ASSISTANT_FLOW.md`
- Cartoes/faturas: `CARD_FLOW.md`

Este documento (`SUMMARY.md`) foi consolidado para ser a referencia principal e atual do backend.
