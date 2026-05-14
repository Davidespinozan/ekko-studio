# Migraciones SQL — EKKO Studio / SALA

Schema versionado con Supabase CLI. Convención `NNN_nombre.sql` aplicado
en orden estricto.

## Migraciones actuales (Fase 0)

| # | Archivo | Descripción |
|---|---|---|
| 000 | extensions.sql | Extensiones Postgres (pgcrypto, pg_trgm, btree_gist) |
| 001 | tenants.sql | Tabla `tenants` + config jsonb + branding + seed EKKO |
| 002 | usuarios.sql | Perfiles extendidos de auth.users con rol y tenant |
| 003 | recursos.sql | Estudios/salas + seed 3 estudios de EKKO |
| 004 | membresias.sql | Tabla `tiers` + tabla `membresias` + seed Básica/Pro |
| 005 | reservas.sql | Reservas + folios + UNIQUE para evitar double-booking |
| 006 | pagos.sql | Journal `payment_events` para webhooks Stripe |
| 007 | helper_functions.sql | `get_my_user_id`, `get_my_tenant_id`, `is_admin`, etc. |
| 008 | rls_policies.sql | RLS estricto por tabla y rol |
| 009 | rpc_reservar.sql | `reservar_recurso_atomic`, `cancelar_reserva_atomic` |
| 010 | trigger_signup.sql | `on_auth_user_created` → crea fila en `usuarios` |

## Aplicar migraciones

### Primera vez (link al proyecto remoto)

```bash
# Linkear el proyecto local al remoto (te pedirá database password)
npx supabase link --project-ref cfihcrjbvgjiohedsjos

# Aplicar todas las migraciones pendientes
npx supabase db push
```

### Después de cada nueva migración

```bash
# Crear migración nueva
npx supabase migration new <nombre_descriptivo>

# Aplicar
npx supabase db push
```

## Regenerar tipos TypeScript

Después de cada `db push`, regenera los tipos del cliente:

```bash
npm run supabase:types
```

Esto sobrescribe `src/shared/types/database.ts` con el schema actual.

## Convenciones

- **Multi-tenant**: todas las tablas operativas llevan `tenant_id`.
- **RLS obligatorio**: cada tabla habilita RLS y define policies explícitas.
- **Funciones SECURITY DEFINER**: para resolver contexto del JWT actual.
- **RPCs atómicos**: operaciones multi-tabla en transacciones únicas.
- **Idempotencia**: usan `IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP ... IF EXISTS`.
- **Errores con prefijo `EKKO_`**: el cliente los traduce a mensajes user-friendly.

## Verificación post-deploy

Después de aplicar las migraciones, verifica en Supabase Studio:

1. Tabla `tenants` tiene 1 fila con `slug = 'ekko'`
2. Tabla `recursos` tiene 3 filas (`estudio-1`, `estudio-2`, `black`)
3. Tabla `tiers` tiene 2 filas (`basica`, `pro`)
4. Todas las tablas tienen RLS habilitado (badge en Studio)
5. Funciones helper aparecen en SQL Editor (`get_my_user_id`, etc.)
