# PROJECT_SETUP

## Requisitos

- Node.js 22+
- npm 10+
- Docker y Docker Compose
- PostgreSQL 16 si se ejecuta sin Docker

## Variables

Copiar `.env.example` a `.env`. No versionar `.env`.

- `DATABASE_URL`: PostgreSQL estándar.
- `JWT_SECRET`: secreto largo y aleatorio.
- `CORS_ORIGIN`: orígenes permitidos.
- `MAPS_PROVIDER`: proveedor del adaptador de mapas.
- `PAYMENTS_PROVIDER`: proveedor de suscripciones.

## Migraciones

```bash
cd api
npx prisma migrate dev --name <descripcion>
npx prisma migrate deploy
npx prisma generate
```

Nunca editar producción con `db push`. Toda modificación debe llegar como migración revisada.

## Docker

```bash
cp .env.example .env
docker compose up -d db
cd api && npm install && npx prisma generate && npx prisma migrate dev --name init && npm run seed && npm run dev
```

Para ejecutar la API en contenedor después de crear la migración:

```bash
docker compose up --build
```

## Contrato de adaptadores

### Mapas

El MVP expone `distanceKm` y `route`. Reemplazar el fallback Haversine por un cliente del proveedor elegido en un módulo separado. Las rutas deben devolver distancia en km, duración en minutos y proveedor usado.

### Pagos

El MVP registra referencias manuales y estado de suscripción. El adaptador de producción debe implementar creación/cancelación/consulta de suscripción y recepción idempotente de webhooks. No guardar PAN, CVV ni credenciales de tarjetas.

## Prueba manual del flujo

Use dos sesiones de navegador o dos clientes API:

1. `POST /api/v1/auth/register` como `DRIVER`.
2. `POST /api/v1/drivers/profile`.
3. Login admin y `GET /api/v1/admin/drivers`.
4. `POST /api/v1/admin/drivers/:id/approve`.
5. `GET /api/v1/subscriptions/plans` y `POST /api/v1/subscriptions/subscribe`.
6. `POST /api/v1/drivers/availability` con lat/lng.
7. Registrar/login como `PASSENGER`.
8. `POST /api/v1/rides/estimate` y `POST /api/v1/rides`.
9. Con el token del conductor, `POST /api/v1/rides/:id/accept`.
10. Avanzar estados con `POST /api/v1/rides/:id/status`.
11. Con el token del pasajero, `POST /api/v1/rides/:id/rating`.

La aceptación usa una actualización condicional de una sola fila dentro de una transacción, por lo que dos conductores no pueden quedarse con el mismo viaje.

## Producción fuera de Manus

- Usar un PostgreSQL gestionado o propio.
- Usar un secreto JWT separado por ambiente.
- Configurar TLS en el reverse proxy.
- Sustituir el fallback de mapas.
- Sustituir payments manual por proveedor aprobado.
- Configurar FCM/APNs en el cliente móvil.
- Aplicar backups y restauración documentados.
