# DECISIONS — EKKO Studio

Índice de decisiones de producto/arquitectura durables. Históricamente vivían
**dispersas en comentarios** del código y migraciones (marcadas `D1`, `H3`,
`L-01`, `R6`, etc.); este archivo las junta para que sean rastreables. Cada
entrada apunta a dónde vive el detalle. El detalle largo de cada bloque está en
`KERNEL.md`.

> Convención: `EKKO-NNN` para decisiones nuevas a partir de acá. Las históricas
> conservan su marcador original (`D1`, `H3`...) para no romper los comentarios
> que las referencian.

---

## Plataforma / infra

- **D-006 — No `await supabase.from()` dentro de `onAuthStateChange`.** El
  cliente Supabase JS v2 hace deadlock si se consulta la DB dentro del callback
  de auth. Diferir con `setTimeout(() => {...}, 0)`. Ver `src/shared/lib/
  supabase.ts` y `src/shared/providers/AuthProvider.tsx`.
- **Tests sin `.env.local`** — `vitest.config.ts` inyecta `VITE_SUPABASE_*`
  placeholder para que los módulos que importan el cliente real no tiren
  `supabaseUrl is required` en CI. No toca runtime.
- **CI** — `lint + tsc + tests + build` en cada push/PR a main
  (`.github/workflows/ci.yml`). El job e2e queda dormido hasta `vars.RUN_E2E` +
  secrets de Supabase.

## Producto — Recepción (serie D)

- **D1 — Walk-ins:** recepción reserva sin validar `min_anticipacion_horas`
  (`reservar_para_miembro_atomic`). Recepción atiende en mostrador, no aplica la
  anticipación del flujo del miembro.
- **D2 — Solo miembros activos:** `reservar_para_miembro_atomic` exige
  `status='activo'` del target.
- **D3 — Cancelación por un tercero:** si cancela recepción/admin (≠ dueño), la
  reserva pasa a `cancelada_admin` + `cancelada_por` + notificación al miembro
  "por el estudio" (`cancelar_reserva_atomic`).
- **D5 — Contrato acotado de alta:** `reception-create-member` fija
  `rol='miembro'` hardcodeado (recepción nunca crea staff) y `tenant` del caller;
  distinto de `admin-create-user`.
- **D6 — Reprogramar no es atómico:** = cancelar la vieja + crear la nueva (dos
  RPCs), con manejo explícito de fallos parciales (`reprogramarReserva.ts`).
- **R3 — Perfil de recepción NO reusa `MiembroDetalle` de admin:** se hizo una
  vista propia para no arrastrar acciones peligrosas (borrar/rol). *(El
  comentario "READ-ONLY" quedó obsoleto: hoy es un hub de gestión.)*
- **R6 — Sin campos sensibles en el SELECT:** el perfil de recepción no pide
  `stripe_customer_id` ni `ob_data`.

## Seguridad (SEC-FIX — serie C/H)

- **C2 — Trigger de columnas privilegiadas:** `usuarios` no deja a un
  `authenticated` tocar `rol/tenant/status/tier/no_shows_count/bloqueado_hasta`
  vía PostgREST. Recepción lo rodea **por diseño** vía Netlify Functions con
  `service_role`. **C2a:** `rol` es intocable salvo `admin-update-role`.
- **H1 — Columnas sensibles aparte:** `stripe_customer_id` y `ob_data` viven en
  `usuarios_datos_privados` (RLS admin-only). Recepción no las alcanza.
- **H3 — Cancelación cross-tenant:** `cancelar_reserva_atomic` valida que un
  tercero solo cancele reservas de su tenant. Replicado en todas las Netlify
  Functions de recepción (`target.tenant_id === caller.tenant_id`).
- **H4 — Passwords nunca al log:** el alta/reset devuelven el password para
  entregar en mostrador, pero no se loguea.
- **H5 — `marcar_no_shows` solo `service_role`:** era ejecutable por cualquier
  `authenticated` (penalizaciones masivas). Revocado.
- **H6 — `QR_JWT_SECRET`** es env var de Netlify (operativo).
- **C1 — Endpoint público sin pago no inserta `payment_event`.**

## Gobernanza / auditoría (Bloque A)

- **`audit_log` insert-only** (sin policies de UPDATE/DELETE), escrito solo por
  `service_role`. SELECT admin = todo el tenant; recepción = `target_tipo='usuario'`.
- **Razón obligatoria** en acciones sensibles (status/tier/desbloqueo/no-show/
  corrección de check-in).
- **B1/B2 — La auditoría salió de `notas_admin`** (campo borrable por admin) al
  `audit_log` inmutable; `notas_admin` vuelve a ser solo notas humanas.
- **B4 — Desbloqueo NO resetea `no_shows_count`** (antes lo ponía en 0 en
  silencio); solo limpia `bloqueado_hasta`.

## Lógica (LOGIC-FIX — serie L)

- **L-01 — Timezone `America/Mazatlan`:** la validación de horario del estudio se
  ancla a la hora de Culiacán, no a la timezone de la sesión Postgres.
- **L-02 — Check-in rechaza todo estado no `confirmada`** (incluido
  `cancelada_admin`).
- **L-03 — `revocado`** agregado al `CHECK` de `usuarios.status`.

## Error-UI (ERROR-UI-FIX — serie E)

- **E-01..E-06 — Nunca exponer el error crudo del servidor al usuario** +
  distinguir "sin datos" de "falló la carga" (estados `isLoading`/`error`
  reales). Traductores `traducirErrorRPC`/`traducirErrorReserva`/
  `traducirErrorRegistro`; `backendPost` propaga el mensaje del servidor.

## Bloques del rediseño de recepción

`A` gobernanza · `B+C` agenda + panel Hoy + nueva IA · `D` no-show manual +
corregir check-in · `E` notas + aviso · `F` recurso fuera de servicio. Detalle
completo en `KERNEL.md`.

---

## Pagos / membresías (D4)

- **D4 — Modelo de cobro (DECIDIDO · 2026-06-12):** **suscripción mensual por
  tier · sin trial · self-serve + recepción.** Ver `STRIPE.md`.
- **Activación en un solo lugar:** RPC keystone `activar_membresia` (escribe
  `membresias` + pone `usuarios.status='activo'`), llamado por
  `reception-activar-membresia` (mostrador, hoy), `stripe-webhook` (futuro) y
  `suscribir-membresia` (atajo simulado). `membresias` deja de estar muerto.
- **B3 — CERRADO:** activar pasa por ese RPC → la cuenta queda consistente
  (cambiar tier + activar ya no deja la cuenta inerte). Antes: cambiar tier no
  tocaba `status`.
- **Plug-and-play Stripe:** todo cableado; conectar Stripe = 3 pasos (env +
  Checkout Session en `suscribir-membresia` + activar en `stripe-webhook`). Ver
  `STRIPE.md` y los marcadores `TODO STRIPE`.
- **EKKO-007 — Billing de Stripe implementado (2026-06-20):** Checkout hosted
  (redirect, sin trial), webhook con **idempotencia** (`stripe_webhook_events`,
  dedupe por `event.id` + borrado-en-error para reintento) y **guardia de orden**
  (`membresias.last_sub_event_at`), Customer Portal (`stripe-portal`), y
  `getOrCreateCustomer` (match por `metadata.usuario_id`, no email). Activación
  por el RPC keystone `activar_membresia`; cambios de estado por
  `sync_membresia_stripe`. **Precios desde `tiers.stripe_price_id` en DB** (NO
  lookup_keys — EKKO es single-tenant, una moneda). **Stripe estándar, cuenta
  del cliente** (NO Connect — no es plataforma multi-negocio). Patrones tomados
  de HSC. Faltan solo los pasos de cuenta/precios/env (ver `STRIPE.md`).

## Planes por créditos

- **EKKO-009 — Planes por créditos/paquetes (2026-06-20):** además del mensual,
  un tier puede ser `tipo='creditos'` (N sesiones sin vencer) o `'hibrido'` (N
  sesiones que vencen en `duracion_dias`); `'tiempo'` = el mensual de siempre
  (default, aditivo). El saldo vive en `membresias.creditos_restantes`; el
  historial en `membresia_movimientos` (ledger append-only). El **descuento y la
  devolución se hacen por TRIGGER sobre `reservas`** (cubre reserva del miembro Y
  de recepción sin tocar los RPCs atómicos; `FOR UPDATE` serializa). Decisiones
  (David): **una membresía vigente por miembro** · **no-show quema el crédito** ·
  **paquetes se suman**. La devolución ocurre si el estudio cancela
  (`cancelada_admin`) o el miembro cancela a tiempo (`anticipacion_min_horas`).
  Pago: paquetes usan Stripe `mode:'payment'` (pago único); mensual `subscription`.
  Mismo webhook y `activar_membresia`. Patrón tomado de SALA.

## Identidad / gate de ingreso

- **EKKO-010 — Ficha de identidad obligatoria + gate de check-in (2026-06-20):**
  el estudio renta espacios con equipo caro → hay que identificar y responsabilizar
  a quien entra. En la 1ª sesión recepción captura **foto (avatar) + fecha de
  nacimiento + domicilio + INE (foto)** y marca **contrato firmado**. Datos
  sensibles en `usuarios_datos_privados` (RLS admin-only), escritos por
  `reception-datos-identidad` (service_role + audit sin valores sensibles); foto
  de INE en bucket **privado** `identidad` (signed URLs). Flags de gate en
  `usuarios` (`identidad_completa`, `contrato_firmado`), protegidos por el trigger
  C2. **Gate**: un trigger BEFORE UPDATE en `reservas` bloquea el check-in
  (`confirmada`→`completada`) con `EKKO_IDENTIDAD_INCOMPLETA` / `EKKO_CONTRATO_PENDIENTE`
  hasta que ambos flags sean true — cubre check-in por QR y manual. Reemplaza la
  idea de pedir estos datos en el signup (fricción + PCI: el signup NO debe
  capturar tarjeta cruda, va por Stripe).

## Pago in-app (Stripe Elements)

- **EKKO-011 — Pago in-app con Stripe Connect + Embedded Checkout (2026-06-20):**
  el pago se hace DENTRO de la app (modal EKKO con `<EmbeddedCheckout>`), sin
  redirigir. **STRYV es la plataforma de Connect; cada estudio (tenant) es una
  cuenta conectada Express que cobra directo a sus miembros (direct charges)** —
  la plataforma nunca toca los fondos. `suscribir-membresia` crea una Checkout
  Session **embebida sobre la cuenta conectada** (`{ stripeAccount }`, precio
  `price_data` inline del tier; mensual=subscription, paquete=payment) y devuelve
  `{ client_secret, account }`; el front hace `loadStripe(pk, { stripeAccount })`.
  Activación por **webhook de Connect** (`checkout.session.completed` con
  `event.account`) vía `activar_membresia`; renovación/past_due/cancelación por
  `sync_membresia_stripe`. Fundación en `connect-onboarding`/`connect-status` +
  `tenants.stripe_account_id`/`stripe_charges_enabled`. Gate `cobros_no_activos`
  si el estudio no completó el onboarding. Portado de SALA. Reemplazó el intento
  previo de Elements/`crear-pago-intent` (borrado). Env: `VITE_STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_CONNECT_WEBHOOK_SECRET`, opcional `EKKO_FEE_PERCENT`. **Requiere validación
  en modo test.**

## Notificaciones

- **EKKO-008 — Web Push implementado (2026-06-20):** entrega fuera de la app
  sobre las notificaciones IN-APP existentes. Tabla `push_subscriptions` (una por
  dispositivo, RLS por dueño), SW `public/push-sw.js` inyectado en Workbox vía
  `importScripts`, cliente en `shared/lib/push.ts` + toggle en Perfil, envío con
  el paquete `web-push` (`_lib/push.ts`, borra suscripciones muertas 404/410).
  **Disparo desde Node** (no trigger de DB): el helper se llama tras cada insert
  en `notificaciones` (aviso manual, recurso fuera de servicio) + cron
  `cron-recordatorios` (RPC `generar_recordatorios_reservas`, recordatorio de
  reserva ~1h antes con dedupe por `reservas.recordatorio_enviado_at`). Patrones
  de HSC. Faltan VAPID keys + env + migraciones (ver `PUSH.md`). Pendiente: el
  cancel client-side no dispara push (ver `BACKLOG.md`).
