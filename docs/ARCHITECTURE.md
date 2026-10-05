# Arquitectura de EKKO — mapa de ruteo

Esto es un MAPA, no una especificación. Dice qué dominios hay, quién tiene la
autoridad en cada uno y dónde leer más. No repite decisiones (`DECISIONS.md`) ni
estado (`docs/STATUS.md`). Carga solo la nota del dominio que toca tu tarea.

## Forma general
- Una app Vite + React + TypeScript con cuatro áreas por ruta: `src/public` (sitio),
  `src/member` (PWA del miembro, `/app`), `src/admin` (panel), `src/reception`
  (mostrador y kiosco QR). Lo compartido en `src/shared`.
- Supabase Postgres con RLS por tenant y rol. La lógica de negocio vive en RPC y
  triggers (`supabase/migrations/`, orden cronológico estricto; la última definición
  de una función manda: `node scripts/db-ultima-def.mjs <fn>`).
- Netlify Functions (`netlify/functions/`) para lo que exige `service_role` o un
  proveedor: Stripe, Resend, push, crons (`netlify.toml`). Comparten `_lib/`.
- Multi-tenant desde el día 1; EKKO es el primer tenant. Reglas del tenant en
  `tenants.config` (jsonb) y marca en `tenants.branding`.

## Regla de autoridad que atraviesa todo
El SERVIDOR decide; la interfaz representa. Dinero y derecho se cambian solo por
RPC o trigger, atómicos e idempotentes, con evidencia durable. Un caché nunca es
autoridad. Ser admin de una fila no autoriza mutar sus invariantes por REST.

## Dominios y dónde leer
| Dominio | Autoridad | Nota | Decisiones (índice) |
|---|---|---|---|
| Plataforma y tenant: config, branding, roles, RLS, identidad de cuenta | `tenants.config`, `usuarios`, policies y triggers de `usuarios` | `arquitectura/plataforma.md` | Seguridad y autorización |
| Membresía, derecho y cobro recurrente: planes, créditos, sanción, revocación, operaciones de Stripe | `membresias` + triggers; `activar_membresia`, `sync_membresia_stripe`, `stripe_operaciones_suscripcion` | `arquitectura/membresia.md` | Membresía y derecho · Stripe y cobro |
| Reservas y asistencia: disponibilidad, reserva, cancelación, reprogramación, check-in, no-show, invitados | tabla `reservas` + sus triggers; RPC `*_atomic`, `reprogramar_reserva`, `staff_corregir_asistencia` | `arquitectura/reservas.md` | Reservas, asistencia y cancelación |
| Dinero y evidencia: pagos, ventas de mostrador, reversales, revisiones, ledger de créditos, libro económico | `payment_events`, `ventas_mostrador`, `reversales_pago`, `revisiones_financieras`, `membresia_movimientos`, `v_libro_economico` | `arquitectura/dinero.md` | Dinero y evidencia financiera |
| Avisos: notificaciones in-app, push, correo | tabla `notificaciones` + triggers; `cron-push`, `cron-email` | (sin nota: leer `netlify/functions/_lib/avisosStaff.ts`, `email.ts`, `push.ts`) | Avisos y correo |

## Qué NO cargar según la tarea
- Cambio de interfaz sin regla de negocio: ningún documento de aquí; solo el código.
- Una pregunta de un dominio: su nota y sus decisiones; no las otras.
- Historia (`docs/archive/`): solo para saber por qué algo fue así antes. Nunca para
  el estado actual ni para una regla vigente.

## Operación
Gate `npm run ci:gate` (lo mismo que construye Netlify). Pruebas de dinero y
derecho contra Postgres real: `src/__tests__/db` con PGlite. Producción se LEE con
`scripts/db-foto-produccion.mjs`. Documentos operativos vigentes: `E2E.md`,
`VALIDACION_PRIMER_USO.md`. `STRIPE.md` y `TENANT_SETUP.md` describen la puesta en
marcha original y tienen partes desactualizadas (ver su encabezado).
