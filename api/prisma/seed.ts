import { PrismaClient, Role, DriverStatus, VehicleStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const cities = ['Moyobamba', 'Tarapoto', 'Nueva Cajamarca', 'Rioja', 'Soritor'];
async function main() {
  for (const name of cities) {
    const city = await prisma.city.upsert({ where: { name }, update: { enabled: true }, create: { name } });
    await prisma.tariffConfig.upsert({ where: { cityId: city.id }, update: {}, create: { cityId: city.id, baseFare: 3, perKm: 1.5, perMinute: 0.2, minimumFare: 5, surcharge: 0 } });
  }
  await prisma.driverPlan.upsert({ where: { id: 'default-driver-plan' }, update: { signupPrice: 5, monthlyPrice: 10, durationDays: 30, graceDays: 3, enabled: true }, create: { id: 'default-driver-plan', name: 'Plan conductor inicial', signupPrice: 5, monthlyPrice: 10, durationDays: 30, graceDays: 3, enabled: true } });
  await prisma.vipPlan.upsert({ where: { id: 'default-vip-plan' }, update: {}, create: { id: 'default-vip-plan', name: 'VIP inicial', price: 15, durationDays: 30, benefits: ['reservas anticipadas', 'preferencia de asiento', 'beneficios configurables'] } });
  const email = process.env.ADMIN_EMAIL ?? 'admin@sanmartin.local';
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  await prisma.user.upsert({ where: { phone: email }, update: {}, create: { phone: email, name: 'Administrador', passwordHash: await bcrypt.hash(password, 12), role: Role.ADMIN } });
  console.log(`Seed completed. Admin login phone: ${email}`);
}
main().finally(() => prisma.$disconnect());
