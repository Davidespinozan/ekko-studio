> **DOCUMENTO HISTÓRICO (archivado 2026-10-05).** Es evidencia de cómo se pensó o auditó algo en su momento; no describe el estado actual ni autoriza trabajo. Vigente: `docs/STATUS.md` (estado), `DECISIONS.md` (decisiones), `docs/ARCHITECTURE.md` (arquitectura).

# Runbook · Ventana conjunta Fase 1 (30 migraciones + Functions + frontend)

Estado previo (2026-09-25): historial de migraciones reparado (62 aplicadas, 30
pendientes: `20260821100000` → `20260925110000`); precheck y drift de producción
limpios; ensayo de las 92 migraciones en base limpia en verde
(`src/__tests__/db/rehearsal-fase1.db.test.ts`). Este documento se ejecuta a mano,
paso a paso, en el orden dado. Nada de aquí corre solo.

## Compatibilidad y orden

| Combinación | ¿Funciona? | Por qué |
|---|---|---|
| Código viejo + base nueva | Sí | `activar_membresia` nueva tiene defaults (los llamadores viejos pasan 5 parámetros nombrados); las RPC que el código viejo usa conservan firma; las columnas nuevas no las lee |
| Código nuevo + base vieja | **No** | El webhook y recepción pasan `p_referencia` / `p_confirmar_perdida` (la función vieja no los acepta); Reservar llama `slots_ocupados`; landing y signup leen `tiers.en_venta` |

Orden técnicamente seguro: **base primero, código después**. Netlify despliega
Functions y frontend en un solo deploy, así que no hay hueco entre ambos.

Ventana de mantenimiento: **NO es imprescindible**, pero hay dos degradaciones
menores entre `db push` y el deploy (minutos): (1) el modal viejo "Editar datos"
de recepción envía `membresia_tier` y la function nueva lo rechaza; con el código
viejo desplegado sigue funcionando porque la function vieja lo acepta, así que solo
afecta si el deploy falla y la base ya cambió; (2) la grilla vieja de Reservar
pinta libres horas que el trigger nuevo de "un set a la vez" rechaza (el miembro ve
un error al reservar, no una doble reserva). Recomendación: hacerlo fuera del
horario del estudio y avisar a recepción que no edite fichas durante la ventana.

## A. Baseline (solo lectura, 5 min)

1. `supabase migration list --linked` → 62 aplicadas, 30 pendientes.
2. Correr `supabase/precheck_identidad_fase1.sql` en el SQL editor. Esperado: C = 0
   filas sin `auth_id`, F = 0 duplicados, K = 0 filas de backfill.
3. Anotar conteos: usuarios 6, membresias 5, tiers 10, recursos 6, reservas 12,
   stripe_webhook_events 48, notificaciones 1.
4. Confirmar variables de entorno en Netlify: `SUPABASE_SERVICE_ROLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
   `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, `QR_JWT_SECRET`, `SENTRY_DSN`.
5. Gate manual: Dashboard → Authentication → Providers → Email → "Allow new users
   to sign up". Esperado **OFF** (todas las altas legítimas usan
   `auth.admin.createUser` con service role; el signup público solo permitiría
   crear `usuarios` sin pasar por `fake-signup`). Si está ON: decidir antes de seguir.

## B. Gate

- Avisar a recepción: no editar fichas ni activar planes durante la ventana.
- Tener a mano el SHA del commit de Fase 1 y el deploy anterior de Netlify
  (para rollback de código).

## C. Migraciones (2 a 5 min)

```
supabase db push --linked
```
Debe reportar las 30 versiones aplicadas. Si falla a mitad: **STOP** (ver P).

## D. Postcondiciones de base (inmediatas, solo lectura)

```sql
SELECT count(*) FROM supabase_migrations.schema_migrations;               -- 92
SELECT indexname FROM pg_indexes WHERE indexname = 'usuarios_tenant_email_lower_uniq'; -- 1 fila (si 0: BLOCKED BY REAL DUPLICATES)
SELECT position('EKKO_IDENTIDAD_AMBIGUA' IN prosrc) > 0 FROM pg_proc WHERE proname = 'handle_new_auth_user'; -- true
SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'activar_membresia'; -- 7 argumentos, una sola fila
SELECT count(*) FROM usuarios WHERE sancionado_at IS NOT NULL;             -- 0
SELECT status, count(*) FROM usuarios GROUP BY 1;                          -- igual que baseline
SELECT tiers_permitidos FROM recursos WHERE slug = 'black';               -- sin 'hola'
SELECT config->'reserva'->>'sets_exclusivos' FROM tenants WHERE slug = 'ekko'; -- true
SELECT count(*) FROM stripe_webhook_events WHERE processed_at IS NULL;    -- 0
SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'tiers_%' OR conname = 'membresias_creditos_no_negativos'; -- todos true
```

## E + F. Deploy de Functions y frontend (un solo deploy de Netlify)

1. `git push` del commit de Fase 1 a la rama que Netlify construye (o deploy
   manual desde ese SHA).
2. Esperar el build en verde. Functions y sitio salen juntos.

## G. Crons

Netlify → Functions → verificar "Scheduled" en `cron-email` (`*/2 * * * *`),
`cron-push`, `cron-material-vencido` (`30 10 * * *`), `cron-expirar-membresias`,
`cron-no-shows`, `cron-recordatorios`. Efecto esperado del primer
`cron-expirar-membresias`: la membresía `esencial` del miembro demo (vencida el
5 de septiembre) pasa a `expirada` y el miembro queda sin plan, status `activo`.

## H. Smoke de Auth y alta

- `/signup?tier=esencial` con un correo NUEVO en mayúsculas y espacios → la fila en
  `usuarios` queda en minúsculas, `pendiente_pago`, vinculada a Auth.
- Mismo correo otra vez → "Ya existe una cuenta". Login del nuevo con la clave.

## I. Alta desde admin

Admin → Miembros → Nuevo con un correo nuevo → 200 y el miembro aparece. Repetir
con un correo existente → 400, sin cuenta huérfana (`SELECT count(*) FROM
auth.users a WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_id = a.id)` = 0).

## J. Ficha de identidad

Recepción → miembro demo → Ficha: cambiar solo el domicilio → guardar → fecha de
nacimiento e INE intactos; el contrato firmado aparece bloqueado. Desconectar la
red y abrir la ficha → error con "Reintentar", sin botón Guardar.

## K. Sanción

Recepción → estado de cuenta → Suspender con motivo → `sancionado_at` con valor;
activar un plan desde mostrador → la cuenta sigue `suspendido`; el miembro no
puede pagar en la app (403). Reactivar → `sancionado_at` NULL, `activo`.

## L. Activación de membresía

Mostrador: activar `sesion-suelta` al miembro demo → `membresias` viva, créditos 1,
`usuarios.membresia_tier = 'sesion-suelta'`, `referencia_pago` con valor.

## M. Reserva

App del miembro → Reservar → las horas ocupadas por otros se ven ocupadas
(`slots_ocupados`); reservar una hora → folio y QR; intentar otro set a la misma
hora → rechazado por "un set a la vez"; cancelar → crédito devuelto.

## N. Stripe y webhook

`node scripts/stripe-check.mjs` (lectura). Pago de prueba de un paquete → evento
`payment_intent.succeeded` → `payment_events` con `usuario_id`, membresía creada,
`stripe_webhook_events.processed_at` con valor. Ejecutar
`scripts/stripe-setup-webhooks.mjs` y `scripts/stripe-wallets-dominio.mjs` con la
llave live SOLO si el `stripe-check` muestra eventos faltantes o el dominio de
Apple Pay sin registrar.

## O. Reconciliación final

Repetir D. Correr `supabase/schema_drift_fase1.sql`: todos los objetos marcados
"pendiente" deben estar presentes. Anotar Sentry sin errores nuevos en 30 min.

## P. Rollback y condiciones de STOP

Las 30 migraciones no se revierten con SQL improvisado. Regla: **STOP y forward-fix**.

| Falla | Acción |
|---|---|
| `db push` falla a mitad | STOP. `supabase migration list --linked` para ver hasta dónde llegó (cada migración es una transacción). Leer el error, corregir el archivo de la migración que falló en el repo, volver a `db push`. El código viejo sigue funcionando con la base parcial (todas las migraciones son aditivas y compatibles hacia atrás). No borrar objetos creados. |
| Base completa, deploy de Netlify falla | El código viejo sigue funcionando con la base nueva. Corregir el build y redeployar. No tocar la base. |
| Deploy completo, smoke H a N falla en una function | Forward-fix de esa function; si es grave, "Rollback to this deploy" en Netlify al deploy anterior: el código viejo es compatible con la base nueva. |
| Smoke de frontend falla | Igual: rollback de código en Netlify es seguro. |
| Postcondición D falla (por ejemplo índice de correo ausente) | No es bloqueante para el deploy; registrar como BLOCKED BY REAL DUPLICATES y decidir a mano. |
| Datos: `black` sin `hola`, `sets_exclusivos = true`, 48 eventos con `processed_at`, 1 notificación marcada | Esperados. No revertir. Si algo de esto debiera deshacerse, es un UPDATE puntual documentado, no un rollback. |

Lo que nunca se hace en la ventana: `DROP` de columnas o funciones nuevas, editar
`schema_migrations` a mano, `migration repair` hacia `reverted`, borrar usuarios,
correr crons a mano antes de verificar G.
