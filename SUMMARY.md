# Resumo do Projeto (API do Chat Despesas)

## Visão geral
- API em Node.js/TypeScript (Express + Prisma + Postgres) que serve exclusivamente o PWA do Chat Despesas.
- Os dados ficam segregados por usuário autenticado via JWT; o backend expõe autenticação, lançamentos, planejamento e dashboards.
- O Telegram saiu do fluxo; resta o consumo direto pela PWA e pelas rotas administrativas.

## Modelos principais
- **User**: email, senha (hash), flags de mudança de senha; integra usuários internos e qualquer credencial manual.
- **Category**: nome normalizado com constraint única por usuário.
- **Expense**: amountCents, descrição, data, categoria, source (marca a origem do lançamento), cartões e parcelas.
- **Card / Credit / Installments**: suporte a cartões com limite, pagamentos e grupos de parcelas.
- **Planning / UserSession**: planejamento mensal e estado de interação para guiar fluxos do frontend.

## Auth e admin
- Login via `POST /api/auth/login` usando `ADMIN_PASSWORD`; o JWT expira em 7 dias e o middleware `authMiddleware` garante acesso às rotas protegidas.
- Administradores usam `X-Admin-Token` para exportar CSV (`/api/admin/exports/expenses.csv`) e gerar backups.

## Fluxo do PWA
- O frontend chama `/api/entries` para listar, criar, editar e remover despesas.
- `/api/categories` devolve todas as categorias do usuário.
- `/api/summary` e `/api/dashboard` consolidam totais mensais, categoriais, cartões e metas.
- `/api/cards`, `/api/credits`, `/api/planning`, `/api/reports`, `/api/quick-entry` e `/api/assistant` complementam o histórico, pagamentos e o assistente de entrada rápida.
- `/api/me` devolve dados do usuário logado para o painel de perfil.

## Relatórios e exportações
- `/api/reports` agrega métricas adicionais; `/api/admin/exports/expenses.csv` gera CSVs filtrados por mês, categoria e fonte.
- Resumo mensal e relatórios continuam em sincronia com o planner do PWA.

## Scripts de manutenção
- `npm run db:backup` / `db:backup:render`: gera JSON completo com usuários, categorias, despesas, rascunhos e sessões.
- `npm run db:restore`: restaura esse JSON em um banco vazio.
- `npm run db:reset`: limpa dados transacionais (despesas, rascunhos, planejamento, sessões) exigindo `RESET_CONFIRM=YES`.
- Outras migrations (`migrateUserData*`) suportam limpeza ou consolidação de dados herdados.

## Assistente Inteligente
- `POST /api/assistant/chat` unifica saudações, entradas rápidas de gastos e perguntas de insights. O backend detecta lançamentos simples (ex.: “mercado 50”), registra usando o parser do quick-entry e confirma no chat, ou busca dados reais (dashboard, categorias, faturas, planejamento) para responder com cards, suggestedActions e estado atual.
- O payload mantém `cards` tipo `metric|list|summary`, sugere ações como “Ver 10 maiores gastos” ou “Mostrar faturas abertas” e expõe `debug.toolsUsed` apenas em DEV.

## Execução
- Desenvolvimento: `npm run dev`
- Build: `npm run build`
- Start (produ‍ção): `npm run build && npm start`
- Prisma: `npm run prisma:migrate`, `prisma:migrate:deploy`, `prisma:studio`

## Observação
- Arquivo atualizado temporariamente para registrar alteração e permitir o push solicitado. V2


