# Migraciones SQL — EKKO

Esquema versionado con el Supabase CLI. Un archivo por cambio, nombre
`YYYYMMDDHHMMSS_nombre.sql`, aplicado en orden cronológico estricto. Hoy hay más de
cien; la tabla que describía las primeras once es historia
(`docs/archive/DEPLOYMENT_fase0.md` y git).

## Reglas estables
- Las migraciones son ADITIVAS: sin UPDATE/DELETE de datos de negocio ni backfill
  inventado. La historia financiera no se reescribe.
- Al recrear una función, parte SIEMPRE de su última definición:
  `node scripts/db-ultima-def.mjs <funcion>` (26 funciones están redefinidas en
  más de una migración).
- Toda regla de dinero o derecho lleva una prueba contra Postgres real en
  `src/__tests__/db` (PGlite aplica todas las migraciones; `EKKO_DB_HASTA` para
  probar que la prueba muerde sin la migración).
- Los checks de `supabase/tests/*.sql` corren en CI.

## Operación
- Plan: `supabase db push --linked --dry-run` debe proponer SOLO lo esperado.
- Aplicar (solo con autorización del dueño; producción no es entorno de pruebas):
  `supabase db push --linked`. Verificar historial y datos después:
  `node scripts/db-foto-produccion.mjs` (solo lectura).
- Tipos TypeScript: `npm run supabase:types`.
- Qué está aplicado en producción: `docs/STATUS.md`, verificado contra
  `supabase_migrations.schema_migrations`.

Arquitectura de la base por dominio: `docs/ARCHITECTURE.md`.
