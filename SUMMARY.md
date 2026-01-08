# Resumo do Projeto (Bot de Despesas Telegram)

## Visao geral
- Bot Telegram em Node.js + TypeScript com grammy.
- Persistencia via Prisma + SQLite; timezone fixo America/Bahia.
- Fluxo seguro: mensagens viram rascunhos (ExpenseDraft) e so salvam apos confirmacao.
- Multiusuario por `telegram_id`; dados isolados por usuario; categorias dinamicas por usuario.

## Modelos principais
- User: telegramId (unique), mustChangePassword.
- Category: name, normalizedName, unique por usuario.
- Expense: amountCents, description, date, categoryId, userId, source, rawText.
- ExpenseDraft: rascunho antes de confirmar.
- UserSession: estado de edicao ou confirmacoes especiais (ex.: apagar mes).

## Auth e admin
- mustChangePassword + endpoint de troca de senha.
- Admin endpoint para criar usuarios.
- Todas as consultas e mutacoes filtradas por usuario.

## Parser de despesas
- Valor: detecta formatos 10 | 10,50 | 10.50 | R$ 10,50 -> amountCents.
- Data: hoje, ontem, DD/MM, DD/MM/YYYY, YYYY-MM-DD (default hoje); normalizacao evita shift de timezone.
- Categoria: "categoria X" -> inferencia por palavras-chave -> "Outros".
- Descricao: texto restante; se vazio, "Sem descricao".
- Retorna `confidence` (high/medium/low) e `issues` (missing_description, ambiguous_category).

## UX de captura
- Mensagem texto -> cria ExpenseDraft, mostra resumo + teclas inline (Confirmar / Editar / Cancelar).
- Se confidence low, sugere edicao.
- Edicao guiada por botoes (valor, categoria, descricao, data); session controla o campo em edicao.

## Menu fixo (Reply Keyboard)
- Botoes:
  - Relatorio (mes) -> /relatorio mes
  - Despesas (lista) -> /despesas mes (paginado)
  - Registrar -> lembrete para enviar texto livre (cria rascunho)
  - Categorias -> /categorias
  - Limpar tela -> apaga ~25 mensagens recentes do bot (nao dados) e confirma
  - Ajuda -> /ajuda
- /menu ativa; /ocultar_menu esconde.

## Comandos principais
- /start: boas-vindas + menu.
- /ajuda: instrucoes + exemplos.
- /categorias: lista categorias do usuario.
- /relatorio [mes|MM/AAAA]: resumo mensal HTML (cabecalho + categorias com %).
- /despesas [mes|MM/AAAA]: lista paginada (10/pg) com inline prev/next.
- /editar ID campo valor: campos valor/descricao/categoria/data.
- /remover ID: remove despesa do usuario.
- /limpar_despesas MM/AAAA: confirmacao em 2 etapas ("APAGAR MM/AAAA"), apaga despesas do mes do usuario.
- /limpar ou botao "Limpar tela": remove ultimas mensagens do bot no chat (nao mexe no banco).

## Relatorio (/relatorio)
- HTML parse_mode.
- Cabecalho: titulo MM/AAAA, periodo (inicio-fim), lancamentos, total.
- Secao Categorias (uma por bloco, com linha em branco): `Nome - R$ valor (X%)`.
- Nao lista despesas no /relatorio (apenas resumo).

## Paginacao (/despesas)
- Comando dedicado; callback data `exp:list:YYYY-MM:page`.
- Cabecalho + meta + total do mes; itens em duas linhas; descricoes truncadas.

## Exportacao CSV
- Exportacao CSV oficial mantida; endpoints debug/compare removidos.

## Outros ajustes recentes
- CORS permite novo origin da PWA.
- Cache-Control e Pragma adicionados.
- Fix build: permite categoryId em updateMany.
- Summary inclui todas as sources; lista PWA mostra todas por padrao.
- Migracao de dados de users antigos para admin.

## Execucao
- Polling por padrao; webhook opcional via env.
- Scripts: dev (tsx watch), build (tsc), start (dist), prisma:migrate/generate/studio.

## Proximas ideias (mencionadas)
- Paginacao "ver mais" no relatorio ou exportacao CSV.
- Audio/Whisper, webhook em prod, versao WhatsApp (futuro).
