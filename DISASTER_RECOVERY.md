# DISASTER_RECOVERY

## Objetivos iniciales

- RPO recomendado: 24 horas durante el MVP; reducirlo antes del lanzamiento público.
- RTO recomendado: 4 horas durante el MVP.
- Nunca considerar Redis, WebSocket o archivos temporales como fuente de verdad de viajes.

## PostgreSQL

Crear backup lógico:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=backup-$(date +%Y%m%d-%H%M).dump
```

Restaurar en una base nueva:

```bash
createdb sanmartin_restore
pg_restore --dbname=postgresql://postgres:postgres@localhost:5432/sanmartin_restore backup.dump
```

Después de restaurar:

```bash
cd api
npx prisma migrate deploy
npm run seed
npm run build
npm start
```

Usar backups cifrados, probar restauración periódicamente y mantenerlos fuera del mismo host que la base activa.

## Archivos

Los documentos de conductores deben residir en almacenamiento privado versionado y con replicación. La base guarda referencias, no archivos binarios críticos. Mantener una política de retención y restauración independiente.

## Recuperación de aplicación

1. Clonar el repositorio Git.
2. Crear `.env` desde `.env.example`.
3. Restaurar PostgreSQL.
4. Ejecutar migraciones pendientes.
5. Instalar dependencias y generar Prisma Client.
6. Ejecutar `npm run build`.
7. Levantar con Docker Compose o `npm start`.
8. Verificar `/health`.
9. Revisar logs y ejecutar pruebas smoke.

## Rollback

- No borrar migraciones aplicadas.
- Desplegar el commit anterior si el esquema sigue siendo compatible.
- Para cambios incompatibles, aplicar migración de reversión explícita y restaurar backup solo con aprobación operativa.
- Registrar el incidente en el audit log y preservar logs.

## Secretos comprometidos

1. Revocar y rotar `JWT_SECRET`.
2. Revocar credenciales de mapas/pagos/SMS.
3. Invalidar sesiones activas si corresponde.
4. Revisar logs de acceso.
5. Documentar alcance y notificar según las obligaciones aplicables.
