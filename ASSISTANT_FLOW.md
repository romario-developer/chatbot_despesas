# Assistant Flow

Detalha como o backend (em `src/api/routes/assistant.ts` + `src/services/assistantConversationService.ts`) controla o registro de lançamentos via `/api/assistant/chat`.

## Máquina de estados

A conversa segue o ciclo descrito abaixo; cada transição depende de quais campos do rascunho (`PendingExpenseDraft`) já foram preenchidos:

1. `ask_description`: pede “Gastou com o quê?” quando ainda não há descrição.
2. `ask_amount`: pergunta o valor sempre que o montante (`amountCents`) fica faltando ou inválido.
3. `ask_payment`: aciona quando descrição e valor existem, mas falta método de pagamento.
4. `ask_card`: aparece só se o pagamento for crédito e ainda não há `cardId`.
5. `confirming`: etapa intermediária registrada antes de gravar o lançamento. O draft completo fica persistido para evitar perder dados caso a API falhe.
6. `saved`: acontece quando a despesa já foi persistida. O draft é zerado e o frontend recebe um `uiHint` com `kind: "saved"` e um resumo (`summary`).

As transições se apoiam em `determineMissingField` (ordem: descrição → valor → pagamento → cartão) e no `STAGE_FOR_FIELD`, que garante as perguntas na sequência certa.

## Reset de conversas

- Chamadas com estágio `idle` ou `saved` (incluindo saudações detectadas e novas sessões) repetem `shouldResetConversation`, que limpa o draft e começa em `ask_description`.
- Cada novo `conversationId` também começa do zero.
- Mesmo quando há um `lastExpenseId` válido (para suportar “desfazer”), o rascunho anterior não é reaproveitado.

## Contrato do endpoint `/api/assistant/chat`

### Requisição

```json
{
  "message": "mercado 50 no cartão",
  "conversationId": "opcional",
  "month": "YYYY-MM"
}
```

### Resposta (estrutura básica)

| Campo | Descrição |
| --- | --- |
| `conversationId` | Identificador da conversa (gera um `UUID` quando não enviado). |
| `assistantMessage` | Texto exibido ao usuário (pergunta, confirmação ou erro). |
| `cards` / `suggestedActions` | Lista vazia, botões de pagamento ou cartões (quando perguntando forma/cartão). |
| `state` | `{ stage, draft? }` onde `stage` segue a máquina acima e `draft` reflete campos já coletados (`amountCents`, `description`, `paymentMethod`, `cardId`, `date`, `categoryName`). |
| `uiHint` | Apenas presente na confirmação final (`kind: "saved"`, com `summary`). |

### Exemplo de fluxo

1. Usuário: `"mercado"`
   - Falta valor → responde `assistantMessage: "Qual foi o valor?"`, `stage: ask_amount`, `draft.description = "mercado"`.
2. Usuário: `"50"`
   - Faltava pagamento → pergunta `ask_payment`.
3. Usuário seleciona `"Crédito"`
   - `ask_card` aparece se ainda não havia cartão; a resposta inclui cards (`buildQuestionActions`).
4. Com todos os campos (`description`, `amountCents`, `paymentMethod`, `cardId` quando necessário) o backend grava o lançamento e responde:

```json
{
  "assistantMessage": "Registrado.",
  "state": { "stage": "saved" },
  "uiHint": { "kind": "saved", "summary": "Mercado — R$50,00 (Crédito Cartão...)" }
}
```

## Ordens cronológicas e mensagens

- O backend responde exatamente uma vez por mensagem do usuário: ou com a próxima pergunta (`stage` em `ask_*`) ou com a confirmação final (`stage: saved` com `uiHint`).
- A etapa `confirming` fica registrada antes da persistência para manter a sequência lógica, mas o frontend só recebe o `state: saved` quando o lançamento foi concluído.

## Em resumo
- O estado compartilha o rascunho (`state.draft`) e o estágio atual para permitir renderizar a pergunta certa e evitar reaproveitar valores antigos.
- Assim que todos os campos obrigatórios estão preenchidos, o backend persiste a despesa, limpa o draft e sinaliza `state.stage = "saved"` + `uiHint.kind = "saved"` para o frontend exibir a confirmação final de forma cronológica.
