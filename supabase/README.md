# Migraciones SQL — EKKO Studio

Schema versionado con Supabase CLI. Convención `NNN_nombre.sql` aplicado en orden estricto.

## Aplicar migraciones

```bash
# Conectar el proyecto local al remoto (solo una vez)
npx supabase link --project-ref cfihcrjbvgjiohedsjos

# Aplicar todas las migraciones pendientes
npx supabase db push

# Crear nueva migración
npx supabase migration new <nombre_descriptivo>
```

## Regenerar tipos TypeScript

```bash
npm run supabase:types
```

Esto regenera `src/shared/types/database.ts` desde el schema actual.
Correlo DESPUÉS de cada `db push`.

## Convenciones

- **Multi-tenant**: todas las tablas operativas llevan `tenant_id uuid NOT NULL`.
- **RLS obligatorio**: cada tabla habilita RLS y define policies explícitas. Nunca dejar `USING (true)`.
- **Funciones `SECURITY DEFINER`**: para resolver `get_my_tenant()`, `get_my_rol()`, `get_my_user_id()`.
- **RPCs atómicos**: operaciones multi-tabla viven en funciones Postgres (transacción única).
- **Idempotencia**: migraciones diseñadas para correr múltiples veces sin romper.

## Estado actual

Vacío. Las migraciones 000-010 se generan en el Prompt 2 (esquema Fase 0).
