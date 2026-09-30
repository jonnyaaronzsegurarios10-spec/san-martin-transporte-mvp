# Etapa 2 — Aplicaciones móviles San Martín Transporte

## Estado de implementación

Se agregaron dos proyectos Flutter nativos:

- `apps/passenger-mobile`: aplicación del pasajero.
- `apps/driver-mobile`: aplicación del conductor.

No se reconstruyó el backend. Las apps reutilizan el backend REST y Socket.IO existente.

## Estructura

Cada app contiene:

- `lib/main.dart`: UI y cliente REST/Socket.IO.
- `android/`: proyecto Android y permisos de ubicación.
- `ios/`: proyecto iOS y textos de permisos de ubicación.
- `pubspec.yaml`: dependencias Flutter.

La URL del backend se configura sin secretos mediante `--dart-define=API_URL=...`.

## APIs conectadas

### Pasajero

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/rides/estimate`
- `POST /api/v1/rides`
- `GET /api/v1/rides/:id` vía contrato disponible del backend
- `POST /api/v1/rides/:id/rating` vía flujo de calificación del backend

La app envía ciudad, origen, destino y método `CASH`, `YAPE`, `PLIN` o `TRANSFER`.

### Conductor

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/drivers/status`
- `POST /api/v1/drivers/availability`
- `POST /api/v1/drivers/location`
- `POST /api/v1/rides/:id/accept`
- `POST /api/v1/rides/:id/status`

## Socket.IO

Se usan los eventos existentes del backend:

- Autenticación mediante `handshake.auth.token`.
- `ride:offer`: nueva solicitud para conductores disponibles.
- `ride:join`: unión a la sala `ride:<id>`.
- `ride:status`: cambios confirmados de estado.
- `location:update`: ubicación del conductor durante el viaje.

El cliente configura transporte WebSocket, reconexión automática y conserva al backend como fuente de verdad.

## GPS y mapas

- `geolocator` solicita permisos y obtiene ubicación real del dispositivo.
- `flutter_map` muestra mapas de OpenStreetMap sin API key embebida.
- El cálculo de tarifa/ruta sigue siendo responsabilidad del adaptador `maps` del backend.
- La ubicación del conductor se publica mediante `/api/v1/drivers/location`.

## Máquina de estados

Las apps no crean una máquina paralela. Renderizan los estados enviados por el backend:

`SEARCHING → MATCHED → DRIVER_ARRIVING → DRIVER_WAITING → IN_PROGRESS → COMPLETED`

Las transiciones se solicitan con `/api/v1/rides/:id/status` y el backend las valida.

## Ejecución

### Backend

```bash
cp .env.example .env
cd api
npm ci
npx prisma generate
npx prisma migrate deploy
npm run seed
npm run dev
```

### Passenger Mobile

```bash
cd apps/passenger-mobile
flutter pub get
flutter run --dart-define=API_URL=http://10.0.2.2:3000
```

Para un teléfono físico, sustituir `10.0.2.2` por la IP LAN del equipo donde corre el backend.

### Driver Mobile

```bash
cd apps/driver-mobile
flutter pub get
flutter run --dart-define=API_URL=http://10.0.2.2:3000
```

### Android

```bash
flutter build apk --debug --dart-define=API_URL=https://api.example.com
flutter build appbundle --release --dart-define=API_URL=https://api.example.com
```

La firma de release y los identificadores finales deben configurarse antes de publicar.

### iOS

```bash
flutter build ios --release --dart-define=API_URL=https://api.example.com
```

La compilación/publicación iOS requiere macOS, Xcode y Apple Developer Program.

## Pruebas realizadas

- `flutter pub get` en ambas apps: correcto.
- `dart format lib/main.dart` en ambas apps: correcto.
- `flutter analyze` en ambas apps: sin errores de Dart; quedan avisos de estilo/deprecación no bloqueantes.
- Backend `npm ci`: correcto.
- Backend `npx prisma generate`: correcto.
- Backend `npm run build`: correcto.
- Backend `npm test`: correcto, 1 smoke test existente.

## Limitaciones encontradas

- El sandbox no tiene Android SDK; por eso `flutter build apk --debug` no pudo ejecutarse aquí. El proyecto Android sí fue generado por Flutter y contiene sus permisos.
- No se ejecutó un viaje end-to-end real con dos dispositivos porque no hay emulador Android ni base PostgreSQL levantada en esta sesión.
- El backend existente solo tiene un smoke test automatizado; la cobertura obligatoria de autenticación, concurrencia, Socket.IO, VIP y reservas todavía debe ampliarse.
- El contrato backend existente expone VIP/reservas, pero las pantallas móviles dedicadas de VIP, reservas, historial, perfil y configuración requieren una iteración adicional de UI para cubrir toda la lista del brief.
- El endpoint backend de perfil/suscripción de conductor existe, pero la UI de onboarding de vehículo/documentos/suscripción aún debe incorporarse antes de considerar la etapa lista para producción.

## Antes de publicar

1. Completar pantallas y pruebas de VIP, reservas, historial, perfil, vehículo y suscripción.
2. Añadir pruebas de integración REST y Socket.IO con PostgreSQL y dos clientes.
3. Validar aceptación atómica con dos conductores concurrentes.
4. Configurar proveedor de mapas, TLS, FCM/APNs y almacenamiento seguro de documentos.
5. Configurar `applicationId`, Bundle ID, firma Android y certificados iOS.
6. Reemplazar credenciales seed de desarrollo y secretos por valores de producción.
7. Ejecutar prueba real: pasajero solicita → conductor recibe/acepta → ubicación → llegada → inicio → finalización → calificación.
