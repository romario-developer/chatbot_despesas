import { InlineKeyboard } from 'grammy';

export function confirmationKeyboard(draftId: string) {
  return new InlineKeyboard()
    .text('Confirmar ✅', `exp:confirm:${draftId}`)
    .text('Editar ✏️', `exp:edit:${draftId}`)
    .row()
    .text('Cancelar ❌', `exp:cancel:${draftId}`);
}

export function editKeyboard(draftId: string) {
  return new InlineKeyboard()
    .text('Valor', `exp:editfield:${draftId}:value`)
    .text('Categoria', `exp:editfield:${draftId}:category`)
    .row()
    .text('Descrição', `exp:editfield:${draftId}:description`)
    .text('Data', `exp:editfield:${draftId}:date`)
    .row()
    .text('Voltar', `exp:edit:${draftId}`)
    .text('Cancelar ❌', `exp:cancel:${draftId}`);
}

export function expensesPaginationKeyboard(
  year: number,
  month: number,
  page: number,
  totalPages: number,
) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  if (!hasPrev && !hasNext) return undefined;

  const kb = new InlineKeyboard();
  const monthStr = String(month).padStart(2, '0');
  if (hasPrev) {
    kb.text('⬅️ Anterior', `exp:list:${year}-${monthStr}:${page - 1}`);
  }
  if (hasNext) {
    if (hasPrev) kb.text('Próximo ➡️', `exp:list:${year}-${monthStr}:${page + 1}`);
    else kb.text('Próximo ➡️', `exp:list:${year}-${monthStr}:${page + 1}`);
  }
  return kb;
}
