import { Keyboard } from 'grammy';

export const MENU_LABELS = {
  report: '📊 Relatório (mês)',
  expenses: '🧾 Despesas (lista)',
  register: '➕ Registrar',
  categories: '🏷️ Categorias',
  clear: '🧹 Limpar tela',
  help: '⚙️ Ajuda',
};

export function buildMenuKeyboard() {
  return new Keyboard()
    .text(MENU_LABELS.report)
    .text(MENU_LABELS.expenses)
    .row()
    .text(MENU_LABELS.register)
    .text(MENU_LABELS.categories)
    .text(MENU_LABELS.clear)
    .row()
    .text(MENU_LABELS.help)
    .resized()
    .persistent();
}

export function removeMenuKeyboard() {
  return { remove_keyboard: true } as const;
}
