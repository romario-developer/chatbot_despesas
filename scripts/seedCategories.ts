import { prisma } from '../src/infra/db/prisma';
import { normalizeCategoryName } from '../src/utils/normalize';

const DEFAULT_CATEGORIES = ['Outros', 'Alimentação', 'Transporte', 'Saúde', 'Casa'];

const DEFAULT_RULES = [
  {
    categoryName: 'Alimentação',
    keywords: 'mercado,supermercado,feira,açougue,padaria,lanche,almoco,janta,pizza,hamburguer,ifood,delivery',
    priority: 10,
  },
  {
    categoryName: 'Transporte',
    keywords: 'posto,gasolina,combustivel,uber,99,onibus,passagem,estacionamento',
    priority: 8,
  },
  {
    categoryName: 'Saúde',
    keywords: 'farmacia,remedio,consulta,exame,medico,medica,dentista',
    priority: 7,
  },
  {
    categoryName: 'Casa',
    keywords: 'energia,luz,agua,internet,aluguel,condominio,gas',
    priority: 6,
  },
];

async function ensureCategoriesForUser(userId: number) {
  for (const name of DEFAULT_CATEGORIES) {
    const normalizedName = normalizeCategoryName(name);
    await prisma.category.upsert({
      where: { userId_normalizedName: { userId, normalizedName } },
      update: { name, isActive: true },
      create: { userId, name, normalizedName },
    });
  }
}

async function ensureRulesForUser(userId: number) {
  for (const rule of DEFAULT_RULES) {
    const normalizedCategoryName = normalizeCategoryName(rule.categoryName);
    const category = await prisma.category.findFirst({
      where: { userId, normalizedName: normalizedCategoryName },
    });
    if (!category) continue;

    const existing = await prisma.categoryRule.findFirst({
      where: { categoryId: category.id, keywords: rule.keywords },
    });
    if (existing) {
      await prisma.categoryRule.update({
        where: { id: existing.id },
        data: { isActive: true, priority: rule.priority },
      });
      continue;
    }

    await prisma.categoryRule.create({
      data: {
        categoryId: category.id,
        keywords: rule.keywords,
        priority: rule.priority,
      },
    });
  }
}

async function main() {
  const users = await prisma.user.findMany();
  if (!users.length) {
    console.warn('[seedCategories] nenhum usuario cadastrado');
    return;
  }

  for (const user of users) {
    await ensureCategoriesForUser(user.id);
    await ensureRulesForUser(user.id);
  }
}

main()
  .then(() => {
    console.log('[seedCategories] concluido');
  })
  .catch((err) => {
    console.error('[seedCategories] falha', err);
  })
  .finally(() => {
    prisma.$disconnect();
  });
