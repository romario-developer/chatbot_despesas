# Resumo do Projeto (Bot de Despesas Telegram)

## Visão geral
- Bot Telegram em Node.js + TypeScript com grammy.
- Persistência via Prisma + SQLite; timezone fixo America/Bahia.
- Fluxo seguro: mensagens de texto viram rascunhos (ExpenseDraft) e só salvam após confirmação.
- Multiusuário por `telegram_id`; categorias dinâmicas por usuário (cria se não existe).

## Modelos principais
- User: telegramId (unique).
- Category: name, normalizedName, unique por usuário.
- Expense: amountCents, description, date, categoryId, userId, source, rawText.
- ExpenseDraft: rascunho antes de confirmar.
- UserSession: estado de edição ou confirmações especiais (ex.: apagar mês).

## Parser de despesas
- Valor: detecta formatos 10 | 10,50 | 10.50 | R$ 10,50 → amountCents.
- Data: hoje, ontem, DD/MM, DD/MM/YYYY, YYYY-MM-DD (default hoje).
- Categoria: “categoria X” > inferência por palavras-chave > “Outros”.
- Descrição: texto restante; se vazio, “Sem descrição”.
- Retorna `confidence` (high/medium/low) e `issues` (missing_description, ambiguous_category).

## UX de captura
- Mensagem texto → cria ExpenseDraft, mostra resumo + teclas inline (Confirmar / Editar / Cancelar).
- Se confidence low, sugere edição.
- Edição guiada por botões (valor, categoria, descrição, data); session controla o campo em edição.

## Menu fixo (Reply Keyboard)
- Botões:
  - 📊 Relatório (mês) → /relatorio mes
  - 🧾 Despesas (lista) → /despesas mes (paginado)
  - ➕ Registrar → lembrete para enviar texto livre (cria rascunho)
  - 🏷️ Categorias → /categorias
  - 🧹 Limpar tela → apaga ~25 mensagens recentes do bot (não dados) e confirma
  - ⚙️ Ajuda → /ajuda
- /menu ativa; /ocultar_menu esconde.

## Comandos principais
- /start: boas-vindas + menu.
- /ajuda: instruções + exemplos.
- /categorias: lista categorias do usuário.
- /relatorio [mes|MM/AAAA]: resumo mensal HTML (cabeçalho + categorias com %).
- /despesas [mes|MM/AAAA]: lista paginada (10/pg) com inline prev/next. Itens: linha1 `ID — descrição`, linha2 `DD/MM — Categoria — R$ valor`.
- /editar ID campo valor: campos valor/descricao/categoria/data.
- /remover ID: remove despesa do usuário.
- /limpar_despesas MM/AAAA: confirmação em 2 etapas (“APAGAR MM/AAAA”), apaga despesas do mês do usuário.
- /limpar ou botão “🧹 Limpar tela”: remove últimas mensagens do bot no chat (não mexe no banco).

## Relatório (/relatorio)
- HTML parse_mode.
- Cabeçalho: título MM/AAAA, período (início-fim), lançamentos, total.
- Seção Categorias (uma por bloco, com linha em branco): `Nome — R$ valor (X%)`.
- Não lista despesas no /relatorio (apenas resumo).

## Paginação (/despesas)
- Comando dedicado; callback data `exp:list:YYYY-MM:page`.
- Cabeçalho + meta + total do mês; itens em duas linhas; descrições truncadas.

## Sanitização/segurança
- Todas as consultas/edições/remoções filtram por `telegram_id`.
- Categoria normalizada (trim, lowercase, espaços simples).
- “Outros” garantido como fallback por usuário.

## Execução
- Polling por padrão; webhook opcional via env.
- Scripts: dev (tsx watch), build (tsc), start (dist), prisma:migrate/generate/studio.

## Próximas ideias (já mencionadas)
- Paginação “ver mais” no relatório ou exportação CSV.
- Áudio/Whisper, webhook em prod, versão WhatsApp (futuro).
