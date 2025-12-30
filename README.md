# Chatbot de Despesas (Telegram + Prisma + SQLite)

Bot de controle de despesas pessoais em PT-BR, multiusuário por `telegram_id`, usando Node.js, TypeScript, Prisma e SQLite.

## Requisitos
- Node.js 20+
- npm

## Criar o bot no BotFather
1. No Telegram, fale com **@BotFather**.
2. Envie `/newbot` e escolha nome e @username.
3. Copie o *token* gerado e coloque em `BOT_TOKEN` no `.env`.
4. Opcional: defina uma descrição e comandos rápidos com `/setdescription`, `/setabouttext` e `/setcommands`.

## Configuração
1. Instale dependências:
   ```bash
   npm install
   ```
2. Crie o arquivo `.env` (existe um exemplo em `.env.example`):
   ```
   BOT_TOKEN=<token do BotFather>
   DATABASE_URL="file:./dev.db"
   PORT=3000
   NODE_ENV=development
   USE_WEBHOOK=false
   WEBHOOK_URL=
   ```
3. Rode as migrações e gere o cliente Prisma:
   ```bash
   npm run prisma:migrate
   ```

## Execução
- Desenvolvimento (polling padrão):
  ```bash
  npm run dev
  ```
- Produção (build + start):
  ```bash
  npm run build
  npm start
  ```
- Healthcheck HTTP: `GET /health`

### Webhook (opcional)
Se quiser usar webhook em vez de polling:
1. Publique o servidor em uma URL pública (HTTPS).
2. No `.env`, defina `USE_WEBHOOK=true` e `WEBHOOK_URL=https://sua-url.com`.
3. Inicie o app (`npm start` ou `npm run dev`). O bot registra o webhook em `/webhook`.

## Como usar (mensagens e comandos)
- Envie textos livres com valor, ex:
  - `paguei 35 no diesel`
  - `mercado 128,90`
  - `pix 60 pro João categoria serviços`
  - `ração 210 animais`
  - `luz 180 categoria contas`
- Regras:
  - Valor: aceita `10`, `10,50`, `10.50`, `R$ 10,50`.
  - Data: se não informar, usa hoje (America/Bahia). Aceita `hoje`, `ontem`, `25/12`, `25/12/2025`, `2025-12-25`.
  - Categoria: `categoria X`, ou inferida por palavras-chave (diesel/combustível, mercado, funcionário, ração, energia/luz/água/internet). Caso contrário, usa **Outros** e cria a categoria se necessário.
  - Descrição: texto restante após remover valor, data e `categoria X`. Se vazio, usa "Sem descrição".
- Fluxo com confirmação:
  - Toda mensagem vira um *rascunho* de despesa (ExpenseDraft) com teclado: Confirmar / Editar / Cancelar.
  - Nada é salvo definitivamente sem clicar em **Confirmar**.
  - Edição guiada: escolha o campo no teclado (Valor, Categoria, Descrição, Data), informe o novo dado, e o bot reexibe o resumo para confirmar.

Comandos:
- `/start` — instruções rápidas
- `/ajuda` — lista de comandos
- `/relatorio mes` — relatório do mês atual
- `/relatorio MM/AAAA` — relatório de mês específico
- `/categorias` — lista de categorias do usuário
- `/editar ID campo novo_valor` — edita `valor`, `descricao`, `categoria` ou `data`
  - Ex: `/editar 12 valor 40,50`
  - Ex: `/editar 12 data 25/12/2025`
- `/remover ID` — remove despesa do usuário

Confirmação de registro:
```
Registrei: R$ 35,00 — diesel — categoria Combustível — 29/12/2025 — ID #12
```

## Notas
- Fuso horário fixo: `America/Bahia` para parsing e formatação.
- Categorias são por usuário; novas categorias são criadas automaticamente.
- Banco padrão SQLite (`dev.db`); ajuste `DATABASE_URL` se necessário.
