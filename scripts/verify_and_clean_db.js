const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const countBefore = await prisma.signal.count();
  console.log('Count before delete:', countBefore);

  const del = await prisma.signal.deleteMany({});
  console.log('Deleted result:', del);

  const countAfter = await prisma.signal.count();
  console.log('Count after delete:', countAfter);

  await prisma.$disconnect();
}

check().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
