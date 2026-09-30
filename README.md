# San Martín Transporte — MVP portable

MVP funcional para conectar pasajeros con conductores de automóvil en **Moyobamba, Tarapoto, Nueva Cajamarca, Rioja y Soritor**.

> El pasajero paga directamente al conductor. El MVP no cobra comisión por viaje. La inscripción inicial del conductor es **S/5** y la mensualidad **S/10**, ambos valores configurables desde administración.

## Estado de esta etapa

Implementado en esta primera etapa:

- API REST versionada (`/api/v1`).
- PostgreSQL estándar mediante Prisma y migraciones.
- JWT + bcrypt desacoplados de Manus.
- Roles pasajero, conductor y administrador.
- Ciudades y tarifas configurables por base de datos.
- Plan de conductor con S/5 de inscripción y S/10 mensual.
- Validación de conductor aprobado, vehículo aprobado, documentos vigentes y suscripción activa.
- Solicitud, estimación, ofertas, aceptación atómica y máquina de estados del viaje.
- Ubicación y eventos de viaje por Socket.IO; historial de ubicaciones limitado al viaje.
- Métodos de pago directo: efectivo, Yape, Plin y transferencia.
- VIP configurable y reservas anticipadas con preferencia FRONT/BACK/ANY.
- Panel administrativo inicial para dashboard, conductores y tarifas/planes.
- Interfaz responsive conectada al backend como arnés de prueba del flujo.
- Docker Compose, `.env.example`, Dockerfile, CI reproducible y documentación de recuperación.

La interfaz web es un **cliente funcional de prueba** y un punto de integración. La envoltura nativa Android/iOS puede agregarse con Expo/React Native o Flutter reutilizando esta API sin cambiar el dominio.

## Ejecución rápida

```bash
cp .env.example .env
cd api
npm install
npx prisma generate
cd ..
docker compose up -d db
cd api
npx prisma migrate dev --name init
npm run seed
npm run dev
```

Abrir `http://localhost:3000`.

Credenciales seed de administración:

- Usuario/teléfono: `admin@sanmartin.local`
- Contraseña: `ChangeMe123!`

Cambiar ambos valores en `.env` antes de cualquier ambiente real.

## Flujo crítico

1. Registrar pasajero y conductor.
2. Completar el perfil del automóvil del conductor.
3. Aprobar conductor/vehículo desde endpoints administrativos.
4. Suscribir al conductor al plan.
5. Activar disponibilidad.
6. Pasajero estima y solicita.
7. El conductor recibe una oferta por WebSocket y acepta.
8. El conductor mueve estados: llegada, espera, inicio y finalización.
9. Pasajero califica el viaje.

## API y portabilidad

- PostgreSQL es la fuente de verdad.
- Redis no es necesario para la primera ejecución; puede añadirse como cache/cola sin cambiar el contrato.
- Maps está detrás del objeto `maps`; actualmente usa fallback Haversine para pruebas. Se puede conectar Google Maps o Mapbox mediante variables y un adaptador.
- Payments está detrás del objeto `payments`; el MVP usa referencias manuales para suscripciones. Se puede conectar Culqi, Mercado Pago u otro proveedor disponible en Perú sin almacenar tarjetas.
- La autenticación usa JWT estándar y puede reemplazarse por otro proveedor manteniendo el contrato de `Authorization: Bearer`.

## Pruebas y CI

```bash
cd api
npm test
npm run build
```

GitHub Actions ejecuta instalación, generación Prisma, migraciones, build y tests contra PostgreSQL 16.

Consulta [`PROJECT_SETUP.md`](PROJECT_SETUP.md) para desarrollo detallado y [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) para copias y restauración.
