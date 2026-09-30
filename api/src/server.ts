import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import bcrypt from 'bcryptjs';
import { PrismaClient, Prisma, Role, RideStatus, SubscriptionStatus, DriverStatus, VehicleStatus, ScheduledRideStatus, PaymentMethod } from '@prisma/client';
import { Server as SocketServer } from 'socket.io';
import path from 'node:path';
import { z } from 'zod';

export const prisma = new PrismaClient();
const app = Fastify({ logger: true });
const httpServer = app.server;
let io: SocketServer;

const rideTransitions: Record<string, RideStatus[]> = {
  SEARCHING: [RideStatus.MATCHED, RideStatus.CANCELLED, RideStatus.EXPIRED],
  MATCHED: [RideStatus.DRIVER_ARRIVING, RideStatus.CANCELLED],
  DRIVER_ARRIVING: [RideStatus.DRIVER_WAITING, RideStatus.CANCELLED],
  DRIVER_WAITING: [RideStatus.IN_PROGRESS, RideStatus.CANCELLED],
  IN_PROGRESS: [RideStatus.COMPLETED, RideStatus.CANCELLED],
};

const maps = {
  distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const r = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return r * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  },
  async route(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const km = this.distanceKm(a, b);
    return { distanceKm: km, durationMinutes: Math.max(1, Math.round(km / 0.35)), provider: process.env.MAPS_PROVIDER ?? 'haversine-fallback' };
  }
};
const payments = {
  provider: process.env.PAYMENTS_PROVIDER ?? 'manual',
  async createSubscriptionReference(driverId: string, planId: string) { return { provider: this.provider, externalId: `manual_${driverId}_${planId}` }; }
};

await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true });
await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-only-change-me' });
await app.register(fastifyStatic, { root: path.resolve(process.cwd(), '../web'), prefix: '/' });

const auth = async (request: any, reply: any) => { try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'UNAUTHORIZED' }); } };
const roles = (...allowed: Role[]) => async (request: any, reply: any) => { if (!allowed.includes(request.user.role)) return reply.code(403).send({ error: 'FORBIDDEN' }); };
const sign = (u: { id: string; role: Role; name: string }) => app.jwt.sign({ sub: u.id, role: u.role, name: u.name });
const currentUser = async (request: any) => prisma.user.findUnique({ where: { id: request.user.sub }, include: { driver: { include: { vehicle: true, subscription: { include: { plan: true } } } }, passenger: true } });
const fail = (reply: any, code: number, error: string) => reply.code(code).send({ error });

app.get('/health', async () => ({ ok: true, service: 'san-martin-transporte-api' }));
app.get('/api/v1/config/public', async () => ({ cities: await prisma.city.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } }), paymentMethods: Object.values(PaymentMethod) }));

app.post('/api/v1/auth/register', async (request, reply) => {
  const body = z.object({ phone: z.string().min(6), name: z.string().min(2), password: z.string().min(8), role: z.enum(['PASSENGER', 'DRIVER']) }).parse(request.body);
  if (await prisma.user.findUnique({ where: { phone: body.phone } })) return fail(reply, 409, 'PHONE_ALREADY_REGISTERED');
  const user = await prisma.user.create({ data: { phone: body.phone, name: body.name, passwordHash: await bcrypt.hash(body.password, 12), role: body.role as Role, driver: body.role === 'DRIVER' ? { create: {} } : undefined, passenger: body.role === 'PASSENGER' ? { create: {} } : undefined } });
  return { token: sign(user), user: { id: user.id, name: user.name, role: user.role, status: user.status } };
});
app.post('/api/v1/auth/login', async (request, reply) => {
  const body = z.object({ phone: z.string(), password: z.string() }).parse(request.body);
  const user = await prisma.user.findUnique({ where: { phone: body.phone } });
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) return fail(reply, 401, 'INVALID_CREDENTIALS');
  if (user.status === 'SUSPENDED') return fail(reply, 403, 'ACCOUNT_SUSPENDED');
  return { token: sign(user), user: { id: user.id, name: user.name, role: user.role, status: user.status } };
});
app.get('/api/v1/me', { preHandler: auth }, async (request, reply) => { const u = await currentUser(request); return u ?? fail(reply, 404, 'USER_NOT_FOUND'); });

app.post('/api/v1/drivers/profile', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any, reply) => {
  const body = z.object({ documentExpiresAt: z.string().datetime(), plate: z.string().min(3), make: z.string().min(1), model: z.string().min(1), color: z.string().min(1) }).parse(request.body);
  const d = await prisma.driver.update({ where: { userId: request.user.sub }, data: { documentExpiresAt: new Date(body.documentExpiresAt), vehicle: { upsert: { create: { plate: body.plate, make: body.make, model: body.model, color: body.color }, update: { plate: body.plate, make: body.make, model: body.model, color: body.color } } } }, include: { vehicle: true } });
  return d;
});
app.get('/api/v1/drivers/status', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any) => {
  const d = await prisma.driver.findUnique({ where: { userId: request.user.sub }, include: { vehicle: true, subscription: { include: { plan: true } } } });
  const now = new Date(); const reasons: string[] = [];
  if (!d || d.status !== DriverStatus.APPROVED) reasons.push('ACCOUNT_NOT_APPROVED');
  if (!d?.vehicle || d.vehicle.status !== VehicleStatus.APPROVED) reasons.push('VEHICLE_NOT_APPROVED');
  if (!d?.documentExpiresAt || d.documentExpiresAt < now) reasons.push('DOCUMENT_EXPIRED');
  if (!d?.subscription || ![SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD].includes(d.subscription.status as any) || (d.subscription.endsAt && d.subscription.endsAt < now)) reasons.push('SUBSCRIPTION_INACTIVE');
  return { available: Boolean(d?.available && reasons.length === 0), reasons, driver: d };
});
app.post('/api/v1/drivers/availability', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any, reply) => {
  const body = z.object({ available: z.boolean(), lat: z.number().optional(), lng: z.number().optional() }).parse(request.body);
  const d = await prisma.driver.findUnique({ where: { userId: request.user.sub }, include: { vehicle: true, subscription: true } });
  if (body.available) {
    const now = new Date(); if (!d || d.status !== 'APPROVED' || d.vehicle?.status !== 'APPROVED' || !d.documentExpiresAt || d.documentExpiresAt < now || !d.subscription || ![SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD].includes(d.subscription.status as any) || (d.subscription.endsAt && d.subscription.endsAt < now)) return fail(reply, 409, 'DRIVER_NOT_ELIGIBLE');
  }
  return prisma.driver.update({ where: { userId: request.user.sub }, data: { available: body.available, lat: body.lat, lng: body.lng, lastLocationAt: new Date() } });
});
app.post('/api/v1/drivers/location', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any, reply) => {
  const body = z.object({ lat: z.number(), lng: z.number(), rideId: z.string().optional() }).parse(request.body);
  const d = await prisma.driver.update({ where: { userId: request.user.sub }, data: { lat: body.lat, lng: body.lng, lastLocationAt: new Date() } });
  if (body.rideId) { await prisma.rideLocation.create({ data: { rideId: body.rideId, actorId: request.user.sub, lat: body.lat, lng: body.lng } }); io.to(`ride:${body.rideId}`).emit('location:update', { lat: body.lat, lng: body.lng }); }
  return d;
});

app.get('/api/v1/rides/available-drivers', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any) => {
  const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).parse(request.query);
  const drivers = await prisma.driver.findMany({ where: { available: true, status: 'APPROVED', vehicle: { status: 'APPROVED' }, subscription: { status: { in: ['ACTIVE', 'GRACE_PERIOD'] } } }, include: { user: true, vehicle: true } });
  return drivers.filter(d => d.lat != null && d.lng != null).map(d => ({ id: d.id, name: d.user.name, vehicle: d.vehicle, distanceKm: maps.distanceKm(q, { lat: d.lat!, lng: d.lng! }) })).sort((a, b) => a.distanceKm - b.distanceKm);
});
app.post('/api/v1/rides/estimate', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any, reply) => {
  const body = z.object({ city: z.string(), pickupLat: z.number(), pickupLng: z.number(), destinationLat: z.number(), destinationLng: z.number() }).parse(request.body);
  const city = await prisma.city.findUnique({ where: { name: body.city }, include: { tariff: true } }); if (!city?.tariff) return fail(reply, 404, 'CITY_OR_TARIFF_NOT_FOUND');
  const route = await maps.route({ lat: body.pickupLat, lng: body.pickupLng }, { lat: body.destinationLat, lng: body.destinationLng });
  const t = city.tariff; const raw = Number(t.baseFare) + route.distanceKm * Number(t.perKm) + route.durationMinutes * Number(t.perMinute) + Number(t.surcharge); const fare = Math.max(Number(t.minimumFare), Math.round(raw * 100) / 100);
  return { city: city.name, fare, distanceKm: route.distanceKm, durationMinutes: route.durationMinutes, tariffSnapshot: { baseFare: t.baseFare, perKm: t.perKm, perMinute: t.perMinute, minimumFare: t.minimumFare, surcharge: t.surcharge } };
});
app.post('/api/v1/rides', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any, reply) => {
  const body = z.object({ city: z.string(), pickupLat: z.number(), pickupLng: z.number(), destinationLat: z.number(), destinationLng: z.number(), paymentMethod: z.nativeEnum(PaymentMethod).default(PaymentMethod.CASH) }).parse(request.body);
  const city = await prisma.city.findUnique({ where: { name: body.city }, include: { tariff: true } }); if (!city?.tariff) return fail(reply, 404, 'CITY_OR_TARIFF_NOT_FOUND');
  const route = await maps.route({ lat: body.pickupLat, lng: body.pickupLng }, { lat: body.destinationLat, lng: body.destinationLng }); const t = city.tariff; const fare = Math.max(Number(t.minimumFare), Math.round((Number(t.baseFare) + route.distanceKm * Number(t.perKm) + route.durationMinutes * Number(t.perMinute) + Number(t.surcharge)) * 100) / 100);
  const ride = await prisma.ride.create({ data: { passengerId: request.user.sub, cityId: city.id, pickupLat: body.pickupLat, pickupLng: body.pickupLng, destinationLat: body.destinationLat, destinationLng: body.destinationLng, estimatedFare: fare, paymentMethod: body.paymentMethod, fareSnapshot: { baseFare: t.baseFare, perKm: t.perKm, perMinute: t.perMinute, minimumFare: t.minimumFare, surcharge: t.surcharge, distanceKm: route.distanceKm, durationMinutes: route.durationMinutes }, statusHistory: { create: { status: RideStatus.SEARCHING, actorId: request.user.sub } } }, include: { city: true } });
  const drivers = await prisma.driver.findMany({ where: { available: true, status: 'APPROVED', vehicle: { status: 'APPROVED' }, subscription: { status: { in: ['ACTIVE', 'GRACE_PERIOD'] } } }, include: { user: true } });
  await prisma.rideOffer.createMany({ data: drivers.map(d => ({ rideId: ride.id, driverId: d.id })) });
  drivers.forEach(d => io.to(`driver:${d.userId}`).emit('ride:offer', { rideId: ride.id, pickupLat: ride.pickupLat, pickupLng: ride.pickupLng, destinationLat: ride.destinationLat, destinationLng: ride.destinationLng, estimatedFare: ride.estimatedFare }));
  return ride;
});
app.get('/api/v1/rides/:id', { preHandler: auth }, async (request: any, reply) => { const ride = await prisma.ride.findUnique({ where: { id: request.params.id }, include: { city: true, offers: true, passenger: true, driver: true, ratings: true, statusHistory: { orderBy: { createdAt: 'asc' } } } }); if (!ride) return fail(reply, 404, 'RIDE_NOT_FOUND'); if (ride.passengerId !== request.user.sub && ride.driverId !== request.user.sub && request.user.role !== 'ADMIN') return fail(reply, 403, 'FORBIDDEN'); return ride; });
app.get('/api/v1/rides', { preHandler: auth }, async (request: any) => { const where = request.user.role === 'PASSENGER' ? { passengerId: request.user.sub } : request.user.role === 'DRIVER' ? { driverId: request.user.sub } : {}; return prisma.ride.findMany({ where, orderBy: { requestedAt: 'desc' }, take: 100, include: { city: true, passenger: true, driver: true, ratings: true } }); });
app.post('/api/v1/rides/:id/accept', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any, reply: any) => {
  const d = await prisma.driver.findUnique({ where: { userId: request.user.sub }, include: { vehicle: true, subscription: true } });
  const now = new Date();
  if (!d || d.status !== 'APPROVED' || d.vehicle?.status !== 'APPROVED' || !d.subscription || ![SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE_PERIOD].includes(d.subscription.status as any) || (d.subscription.endsAt && d.subscription.endsAt < now)) return fail(reply, 409, 'DRIVER_NOT_ELIGIBLE');
  try {
    const updated = await prisma.$transaction(async tx => {
      const claim = await tx.ride.updateMany({ where: { id: request.params.id, status: RideStatus.SEARCHING, driverId: null }, data: { driverId: request.user.sub, status: RideStatus.MATCHED, acceptedAt: now } });
      if (claim.count !== 1) throw new Error('RIDE_ALREADY_CLAIMED');
      await tx.rideOffer.updateMany({ where: { rideId: request.params.id, driverId: { not: d.id } }, data: { status: 'CLOSED' } });
      await tx.rideOffer.updateMany({ where: { rideId: request.params.id, driverId: d.id }, data: { status: 'ACCEPTED' } });
      await tx.rideStatusHistory.create({ data: { rideId: request.params.id, status: RideStatus.MATCHED, actorId: request.user.sub } });
      return tx.ride.findUnique({ where: { id: request.params.id } });
    });
    io.to(`ride:${request.params.id}`).emit('ride:status', updated); return updated;
  } catch (error) { if (error instanceof Error && error.message === 'RIDE_ALREADY_CLAIMED') return fail(reply, 409, 'RIDE_ALREADY_CLAIMED'); throw error; }
});
app.post('/api/v1/rides/:id/status', { preHandler: auth }, async (request: any, reply) => {
  const body = z.object({ status: z.nativeEnum(RideStatus) }).parse(request.body); const ride = await prisma.ride.findUnique({ where: { id: request.params.id } }); if (!ride) return fail(reply, 404, 'RIDE_NOT_FOUND'); if (ride.passengerId !== request.user.sub && ride.driverId !== request.user.sub) return fail(reply, 403, 'FORBIDDEN'); if (!rideTransitions[ride.status]?.includes(body.status)) return fail(reply, 409, 'INVALID_RIDE_TRANSITION');
  const timestamps: any = body.status === 'IN_PROGRESS' ? { startedAt: new Date() } : body.status === 'COMPLETED' ? { completedAt: new Date(), finalFare: ride.estimatedFare } : {};
  const updated = await prisma.$transaction(async tx => { const r = await tx.ride.update({ where: { id: ride.id }, data: { status: body.status, ...timestamps } }); await tx.rideStatusHistory.create({ data: { rideId: ride.id, status: body.status, actorId: request.user.sub } }); return r; }); io.to(`ride:${ride.id}`).emit('ride:status', updated); return updated;
});
app.post('/api/v1/rides/:id/rating', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any, reply) => { const body = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).parse(request.body); const ride = await prisma.ride.findUnique({ where: { id: request.params.id } }); if (!ride || ride.passengerId !== request.user.sub || ride.status !== 'COMPLETED') return fail(reply, 409, 'RIDE_NOT_RATEABLE'); return prisma.rating.create({ data: { rideId: ride.id, authorId: request.user.sub, passengerId: (await prisma.passenger.findUnique({ where: { userId: request.user.sub } }))?.id, score: body.score, comment: body.comment } }); });

app.get('/api/v1/subscriptions/plans', { preHandler: auth }, async () => prisma.driverPlan.findMany({ where: { enabled: true } }));
app.post('/api/v1/subscriptions/subscribe', { preHandler: [auth, roles(Role.DRIVER)] }, async (request: any, reply) => { const body = z.object({ planId: z.string() }).parse(request.body); const d = await prisma.driver.findUnique({ where: { userId: request.user.sub } }); const plan = await prisma.driverPlan.findUnique({ where: { id: body.planId } }); if (!d || !plan) return fail(reply, 404, 'PLAN_NOT_FOUND'); const ref = await payments.createSubscriptionReference(d.id, plan.id); const now = new Date(); return prisma.driverSubscription.upsert({ where: { driverId: d.id }, create: { driverId: d.id, planId: plan.id, status: 'ACTIVE', startsAt: now, endsAt: new Date(now.getTime() + plan.durationDays * 86400000) }, update: { planId: plan.id, status: 'ACTIVE', startsAt: now, endsAt: new Date(now.getTime() + plan.durationDays * 86400000) } }).then(s => ({ ...s, paymentReference: ref })); });

app.get('/api/v1/vip/plans', { preHandler: auth }, async () => prisma.vipPlan.findMany({ where: { enabled: true } }));
app.post('/api/v1/vip/subscribe', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any, reply) => { const body = z.object({ planId: z.string() }).parse(request.body); const p = await prisma.vipPlan.findUnique({ where: { id: body.planId } }); const passenger = await prisma.passenger.findUnique({ where: { userId: request.user.sub } }); if (!p || !passenger) return fail(reply, 404, 'VIP_PLAN_NOT_FOUND'); return prisma.passenger.update({ where: { id: passenger.id }, data: { vipPlanId: p.id } }); });
app.post('/api/v1/vip/reservations', { preHandler: [auth, roles(Role.PASSENGER)] }, async (request: any, reply) => { const body = z.object({ vipPlanId: z.string(), scheduledFor: z.string().datetime(), pickupLat: z.number(), pickupLng: z.number(), destinationLat: z.number(), destinationLng: z.number(), seatPreference: z.enum(['FRONT', 'BACK', 'ANY']).default('ANY') }).parse(request.body); const passenger = await prisma.passenger.findUnique({ where: { userId: request.user.sub } }); if (!passenger || passenger.vipPlanId !== body.vipPlanId) return fail(reply, 403, 'VIP_REQUIRED'); const when = new Date(body.scheduledFor); if (when <= new Date()) return fail(reply, 400, 'SCHEDULE_MUST_BE_FUTURE'); const conflict = await prisma.scheduledRide.findFirst({ where: { passengerId: passenger.id, scheduledFor: { gte: new Date(when.getTime() - 30 * 60000), lte: new Date(when.getTime() + 30 * 60000) }, status: { notIn: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] } } }); if (conflict) return fail(reply, 409, 'SCHEDULE_CONFLICT'); return prisma.scheduledRide.create({ data: { passengerId: passenger.id, vipPlanId: body.vipPlanId, scheduledFor: when, pickupLat: body.pickupLat, pickupLng: body.pickupLng, destinationLat: body.destinationLat, destinationLng: body.destinationLng, seatPreference: body.seatPreference } }); });

app.get('/api/v1/admin/dashboard', { preHandler: [auth, roles(Role.ADMIN)] }, async () => ({ users: await prisma.user.count(), drivers: await prisma.driver.count(), activeDrivers: await prisma.driver.count({ where: { available: true } }), vehicles: await prisma.vehicle.count(), rides: await prisma.ride.count(), completedRides: await prisma.ride.count({ where: { status: 'COMPLETED' } }), cancelledRides: await prisma.ride.count({ where: { status: 'CANCELLED' } }), activeSubscriptions: await prisma.driverSubscription.count({ where: { status: 'ACTIVE' } }), vipPassengers: await prisma.passenger.count({ where: { vipPlanId: { not: null } } }), scheduledRides: await prisma.scheduledRide.count() }));
app.get('/api/v1/admin/drivers', { preHandler: [auth, roles(Role.ADMIN)] }, async () => prisma.driver.findMany({ include: { user: true, vehicle: true, subscription: { include: { plan: true } } } }));
app.post('/api/v1/admin/drivers/:id/approve', { preHandler: [auth, roles(Role.ADMIN)] }, async (request: any, reply) => { const d = await prisma.driver.update({ where: { id: request.params.id }, data: { status: 'APPROVED', vehicle: { update: { status: 'APPROVED' } } }, include: { user: true, vehicle: true } }); await prisma.auditLog.create({ data: { actorId: request.user.sub, action: 'APPROVE_DRIVER', entity: 'Driver', entityId: d.id } }); return d; });
app.get('/api/v1/admin/config', { preHandler: [auth, roles(Role.ADMIN)] }, async () => ({ cities: await prisma.city.findMany({ include: { tariff: true } }), driverPlans: await prisma.driverPlan.findMany(), vipPlans: await prisma.vipPlan.findMany() }));
app.patch('/api/v1/admin/tariffs/:cityId', { preHandler: [auth, roles(Role.ADMIN)] }, async (request: any) => { const b = z.object({ baseFare: z.number().nonnegative(), perKm: z.number().nonnegative(), perMinute: z.number().nonnegative(), minimumFare: z.number().nonnegative(), surcharge: z.number().nonnegative().default(0) }).parse(request.body); return prisma.tariffConfig.update({ where: { cityId: request.params.cityId }, data: b }); });
app.patch('/api/v1/admin/driver-plans/:id', { preHandler: [auth, roles(Role.ADMIN)] }, async (request: any) => { const b = z.object({ signupPrice: z.number().nonnegative(), monthlyPrice: z.number().nonnegative(), durationDays: z.number().int().positive(), graceDays: z.number().int().nonnegative(), enabled: z.boolean().optional() }).parse(request.body); return prisma.driverPlan.update({ where: { id: request.params.id }, data: b }); });
app.get('/', async (_, reply) => reply.sendFile('index.html'));

await app.ready();
io = new SocketServer(httpServer, { cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' } });
io.use((socket, next) => { const token = socket.handshake.auth?.token; if (!token) return next(new Error('UNAUTHORIZED')); try { const decoded: any = app.jwt.verify(token); socket.data.userId = decoded.sub; socket.data.role = decoded.role; next(); } catch { next(new Error('UNAUTHORIZED')); } });
io.on('connection', socket => { const { userId, role } = socket.data; socket.join(role === 'DRIVER' ? `driver:${userId}` : `user:${userId}`); socket.on('ride:join', (rideId: string) => socket.join(`ride:${rideId}`)); });

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== 'test') app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`API listening on ${port}`));
export { app, httpServer, io };
