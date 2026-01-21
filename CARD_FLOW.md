## Fluxo de cartões

O backend expose o fluxo completo de cartões a partir de diversas rotas sob o prefixo `/api/cards`. Abaixo está um resumo organizado por responsabilidades principais:

### Listagem e cadastro de cartões
1. **GET `/api/cards`** (`src/api/routes/cards.ts`): retorna todos os cartões do usuário autenticado com campos básicos (`id`, `nome`, `bandeira`, limites, cores e datas). Utilizado tanto para mostrar “Cartões disponíveis” quanto para alimentar seletores de cartão nas telas.
2. **POST `/api/cards`**: cria um novo cartão após validações de nome, bandeira (`VISA`, `MASTERCARD`, etc.), limite (conversão para centavos), `closingDay`, `dueDay` e cores (`#RRGGBB`). O cartão novo herda um `userId` com o usuário logado.
3. **PUT `/api/cards/:id`** e **DELETE `/api/cards/:id`**: atualizam ou removem o cartão depois de validarem `id` e checar `userId`. Os updates reutilizam os validadores de dia e cores do cadastro.

### Visão geral e ciclos
1. **GET `/api/cards/summary`**: entrega uma lista com cada cartão, limite e dias de fechamento/vencimento, permitindo construir cards como “Cartões disponíveis” e mostrar o mês atual.
2. **GET `/api/cards/invoices`**: (a partir desta entrega) calcula faturas por cartão com base em `closingDay`, trazendo totais de gastos no ciclo (somatório de despesas com `paymentMethod: 'CREDIT'`) menos pagamentos e adicionando novos campos como `paidTotal`, `remaining`, `status` (ABERTA/FECHADA/PAGA) além de `entriesCount`.
3. **POST `/api/cards/payments`**: registra pagamento associado ao cartão e ao ciclo (`cycleEnd` derivado do `closingDay`), retornando valores convertidos de centavos, `paidAt`, `cycleStart` e `cycleEnd`, sem impactar o saldo da conta.

### Regras e utilitários
- `getCardCycleRange` (em `src/domain/cardCycle.ts`) calcula o intervalo do ciclo de fechamento do cartão a partir da data de referência e do `closingDay`.
- `centsToNumber` e `toAmountCents` (em `src/utils/money.ts`) fazem a conversão entre moeda apresentada e armazenada em centavos.
- O fluxo autentica via `authMiddleware`, garantindo que apenas o titular manipule seus cartões.

### Integração com o frontend
- A PWA exibe “Cartões disponíveis”, “Detalhe da fatura” e “Próximas faturas” consultando as rotas acima. Quando não há cartões, o backend retorna `items: []` e a interface exibe a mensagem.
- Ao selecionar um cartão e navegar em faturas, o frontend usa `/api/cards/invoices` e combina com `/api/cards/payments` para mostrar valor devido e permitir registrar pagamentos. O novo payload agora inclui `paidTotal`, `remaining`, `status`, `cycleStart` e `cycleEnd`.

### Observações de estabilidade
- Todas as rotas logam erros quaisquer exceções (ex.: tabela `CardPayment` ausente é ignorada com warning) e usam prefixos como `[cards/invoices]`.
- O middleware valida `month` e `asOf` com regex e `dayjs` para evitar chamadas inválidas.
- As despesas com `paymentMethod: 'CREDIT'` não reduzem mais o saldo contado pelo dashboard/resumo: o filtro `paymentMethod: { not: 'CREDIT' }` alimenta o cálculo de `balance`.

### Verificações manuais recomendadas
1. Crie uma despesa com `paymentMethod: 'CREDIT'` e `cardId` válido via `/api/entries` e confirme nos logs (`[entries] created ...`) que ela não influencia o saldo exibido em `/api/summary` ou `/api/dashboard`.
2. Consulte `/api/cards/invoices?asOf=YYYY-MM-DD` para garantir que `invoiceTotal` reflete o somatório das despesas de crédito no ciclo e que `remaining`, `paidTotal` e `status` mudam conforme você registra pagamentos.
3. Use `/api/cards/payments` para criar um pagamento e confirme que a resposta inclui `cycleStart`, `cycleEnd` e `paidAt`, e que o campo `remaining` da próxima chamada em `/api/cards/invoices` diminui até zerar e muda `status` para `PAGA`.
4. Verifique que `/api/cards/summary` e `/api/dashboard/summary` continuam funcionando sem credit: mesmo com faturas abertas, o saldo reflete apenas despesas no dinheiro/débito.
