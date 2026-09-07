const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSignalsTable() {
  const list = await prisma.signal.findMany({
    include: { instrument: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`TOTAL SIGNALS IN DB: ${list.length}`);
  list.forEach((s, idx) => {
    console.log('----------------------------------------------------');
    console.log(
      `${idx + 1}. [${s.instrument?.symbol || s.instrumentId}] ${s.direction} | State: ${s.state} | Entry: ₹${s.entryPrice} | SL: ₹${s.stopLoss} | Exit: ₹${s.exitPrice} | PnL: ₹${s.pnlAmount} (${s.pnlRMultiple}R)`,
    );
    console.log(
      `   Activated: ${s.activatedAt?.toISOString()} | Closed: ${s.closedAt?.toISOString()} | Created: ${s.createdAt?.toISOString()}`,
    );
    console.log(`   Reasons:`, JSON.stringify(s.reasonsJson));
  });

  await prisma.$disconnect();
}

checkSignalsTable().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
