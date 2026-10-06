# DECISIONS — EKKO Studio

Índice de decisiones de producto/arquitectura durables. Históricamente vivían
**dispersas en comentarios** del código y migraciones (marcadas `D1`, `H3`,
`L-01`, `R6`, etc.); este archivo las junta para que sean rastreables. Cada
entrada apunta a dónde vive el detalle. La historia larga de los primeros bloques
está archivada en `docs/archive/KERNEL.md`; la arquitectura vigente, en
`docs/ARCHITECTURE.md`.

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
- **D6 — Reprogramar no es atómico:** **[SUSTITUIDA por EKKO-122: hoy SÍ es atómico]** = cancelar la vieja + crear la nueva (dos
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
completo en `docs/archive/KERNEL.md` (histórico).

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
  cancel client-side no dispara push (ver `docs/archive/BACKLOG.md`).

## Paridad con SALA — Sprint 0/1 (2026-08-21)

Bugs y endurecimientos portados de SALA (ver `docs/archive/SALA_PARITY_AUDIT.md`, commits de
la rama `sprint-0-hotfixes`). Cada uno deja un self-test en su migración o un
test en `src/__tests__`.

- **EKKO-012 — Crons con sintaxis real de Netlify.** `[[scheduled_functions]]`
  no existe; los 3 crons no corrieron nunca. Declarados como
  `[functions."cron-x"] schedule`; `netlify-crons.test.ts` falla si vuelve.
- **EKKO-013 — El plan se valida contra `tiers` del estudio**, nunca contra una
  lista fija (`reception-update-member`).
- **EKKO-014 — Penalización por no-show obedece a la config.**
  `config.penalizaciones.{no_show_bloqueo_dias (0 = solo registrar), no_show_umbral}`
  la leen el cron (`marcar_no_shows`) y recepción vía `_lib/noShow.ts`; el miembro
  recibe aviso in-app/push (`tipo='no_show'`).
- **EKKO-015 — La devolución de créditos usa la ventana de CANCELACIÓN** **[default 0 SUSTITUIDO por EKKO-133: 24 h, igualdad = tarde]**
  (`cancelacion_min_horas_antes`, 0 = sin ventana), igual que
  `cancelar_reserva_atomic`. Sustituye la regla de EKKO-009 que usaba
  `anticipacion_min_horas`.
- **EKKO-016 — `tiers_permitidos` vacío = estudio abierto.** Gate único
  `_recurso_permite_tier`; trigger en `recursos` exige slugs de planes activos del
  tenant; archivar/renombrar un plan actualiza las listas. Front y base coinciden.
- **EKKO-017 — Acceso:** `/recuperar` + `/nueva-contrasena`, "Cambiar contraseña"
  en el perfil, y `CambiarPasswordGate` en los 3 layouts disparado por la
  notificación `cambiar_password` que dejan alta/reset de staff. Las claves
  temporales siguen siendo aleatorias (no `Cambiar123` como SALA: aquí hay
  tarjeta y créditos). Recepción no puede resetear claves del staff.
- **EKKO-018 — La ficha admin lee `membresias`** (`MembresiaActualCard`), cambia
  el plan por `reception-update-member` (motivo + audit) y activa por el RPC
  keystone `activar_membresia`. Cierra B3.
- **EKKO-019 — Webhook de Connect en cuenta compartida:** descarta (200) eventos
  de cuentas conectadas ajenas (`cuenta_ajena`) y objetos con `metadata.app ≠ 'ekko'`
  (`app_ajena`); procesa `account.updated` para refrescar el gate de cobro.
- **EKKO-020 — Privilegios:** `expirar_membresias_vencidas` solo `service_role`;
  `tenants` con SELECT/UPDATE por columnas (stripe_* solo backend); storage de
  escritura atado al tenant por path; `count_*` acotados con
  `COALESCE(get_my_tenant_id(), param)`. Checks en
  `supabase/tests/hardening_checks.sql`.
- **EKKO-021 — Paquetes fuera del MRR** (`esRecurrente`); se cuentan aparte.

## Paridad con SALA — Sprints 2/3/4 (2026-08-21)

- **EKKO-022 — Plataforma:** `backend.ts` refresca el token si vence en <120 s
  y reintenta UNA vez tras 401; PWA recarga sola al activarse un SW nuevo
  (`controllerchange`, chequeo al volver a la pestaña y cada 2 min,
  `vite:preloadError`, `lazyConRecarga`); Sentry en functions
  (`_lib/sentry.ts`: `reportarErrorServidor`, `conMonitorCron`, centinela de
  frescura en `cron-expirar-membresias`); `setSentryUser` al hidratar.
- **EKKO-023 — Zona del estudio en la UI:** toda fecha de calendario se
  calcula en `America/Mazatlan` (`timezone.ts`: `fechaISOEnZona`,
  `rangoDiaEnZona`, `formatHoraEnZona`…). Recepción trabaja con el día ISO del
  estudio; slots y labels salen de `reservaLogic` en esa zona. Pendiente:
  `VistaSemana`/`VistaDia` del calendario.
- **EKKO-024 — Recepción reserva al nivel del socio:**
  `reservar_para_miembro_atomic` valida horario, `permitir_continuas`,
  `FOR UPDATE`, traduce el constraint anti-solape y toma `max_invitados` de
  `tiers.reglas`. Sigue **sin** anticipación mínima (D1) y sin tope diario.
  `trg_anticipacion_maxima` valida `anticipacion_max_dias` en la base solo para
  miembros. Recepción lee `membresias` (`membresias_read_staff`).
- **EKKO-025 — Corregir asistencia:** **[SUSTITUIDA por EKKO-121: una cancelada no se revive]** `reception-marcar-asistio` pasa un
  no_show/cancelada ya iniciada a `completada`, revierte la falta y levanta el
  bloqueo si se debía a ella; los créditos no se re-cobran.
- **EKKO-026 — `tiers.en_venta`** separa "se vende" de "está activo". La venta
  (landing/signup/pago en la app) filtra `en_venta`; asignar desde staff sigue
  por `activo`.
- **EKKO-027 — Avisos:** `avisar_membresias_por_vencer` solo cuando el miembro
  debe actuar (paquetes con caducidad, membresías de mostrador,
  `cancel_at_period_end`), una vez por periodo; felicitación de cumpleaños
  desde la ficha de identidad; `cumpleanos_proximos` para la card de staff.
  Cobro rechazado y reembolso avisan al equipo (`_lib/avisosStaff.ts`) y la
  campana vive en los 3 layouts.
- **EKKO-028 — Reembolsos:** **[SUSTITUIDA por EKKO-112]** `charge.refunded` se registra como `refunded` en
  `payment_events` y NO revierte créditos/membresía automáticamente: decide el
  estudio desde la ficha.
- **EKKO-029 — Fee de plataforma** (`EKKO_FEE_PERCENT`) aplica en todos los
  flujos de cobro (Checkout y Elements). Default 0.

## Paridad con SALA — Sprint 5 (2026-08-21)

- **EKKO-030 — La membresía se revalida en la puerta.** `_estado_membresia_checkin`
  (si la sesión ya se pagó con créditos → `ok`). El QR bloquea
  (`EKKO_MEMBRESIA_NO_VIGENTE`); el check-in manual no bloquea y devuelve
  `membresia_estado` para que recepción decida.
- **EKKO-031 — El tope diario cuenta no-show y cancelación tardía** (dentro de
  `cancelacion_min_horas_antes`): faltar o cancelar tarde no libera el día.
- **EKKO-032 — Estado `pausada`.** `staff_pausar_membresia` (rol + tenant +
  aviso + audit) tras pausar la facturación en Stripe (`pause_collection`,
  con rollback). La cuenta queda `suspendido` mientras dure.
  `sync_membresia_stripe` deriva `pausada` de `pause_collection`.
- **EKKO-033 — Push central.** `notificaciones.push_enviado_at` + `cron-push`
  (cada minuto) reparte lo pendiente de cualquier origen. Las functions que
  empujan inline marcan la fila al insertar; las RPC no empujan (lo hace el
  cron). Reemplaza el cableado disparador por disparador de EKKO-008.
- **EKKO-034 — Reportes "cobrado · dinero real"** **[SUSTITUIDA por EKKO-126]** desde `payment_events`
  (mes actual vs. anterior, por concepto, reembolsos, cobros rechazados 30 d),
  separado del MRR (ingreso contratado).

## Paridad con SALA — Auditoría #2, Sprint A (2026-09-20)

Detalle y evidencia en `docs/archive/SALA_PARITY_AUDIT_2.md` §2 y §7.

- **EKKO-035 — Tests conductuales de la base (`src/__tests__/db`).** Un Postgres
  real embebido (PGlite, sin Docker ni psql) aplica TODAS las migraciones y
  ejecuta las RPC como lo hace la app. Corre con `vitest`, o sea en CI. Reemplaza
  como red de seguridad a los "contratos" `position(texto in prosrc)`, que
  afirman que una función contiene una frase, no que se comporta bien.
  `EKKO_DB_HASTA=<timestamp>` aplica solo hasta esa migración (para comprobar que
  un test nuevo falla antes del fix). Regla: toda migración que toque dinero o
  acceso lleva su caso aquí.
- **EKKO-036 — Reservar exige una membresía viva, en el trigger de débito.**
  `creditos_debitar_al_reservar`: sin membresía → `EKKO_SIN_MEMBRESIA`. Vive en
  el trigger (no en las RPC) porque toda inserción a `reservas` pasa por él y así
  no se recrean dos RPC largas. Vale también para recepción. Mensual con
  suscripción Stripe: manda el `status` del webhook, no la fecha (`invoice.paid`
  puede tardar); mensual de mostrador (sin Stripe): sí se valida la fecha.
- **EKKO-037 — El trigger de débito es AFTER INSERT.** Como BEFORE insertaba el
  asiento del ledger con un `reserva_id` que aún no existía (FK no diferible):
  ningún miembro con paquete podía reservar. Un RAISE en AFTER aborta igual la
  inserción, y un slot ocupado ya no llega a debitar.
- **EKKO-038 — La duración la fija el estudio.** Miembro: exactamente
  `reserva.duracion_default_min`. Staff: 15 min–8 h (reprogramar conserva la
  duración original). Nadie cruza la medianoche del estudio.
- **EKKO-039 — Staff inactivo = sin poderes.** `is_admin()`, `is_recepcionista()`
  y `get_my_rol()` exigen `status='activo'`; `get_my_rol()` devuelve `'revocado'`
  y NO `NULL` (con NULL, `IF v_rol NOT IN (…)` no dispara y los triggers lo
  tratan como proceso sin sesión). Toda function de staff valida al caller con
  `_lib/staff` (`esStaffActivo` / `esAdminActivo`); un test falla si una function
  compara el rol a mano. Admin y recepción sacan del panel a la sesión abierta de
  una cuenta inactiva. La migración normaliza a `activo` al staff `pendiente_*`
  y ABORTA si un tenant se quedaría sin ningún admin activo.
- **EKKO-040 — Recepción solo opera sobre miembros** (`puedeOperarSobre`): las
  cuentas del equipo las toca un admin. Un admin no se cambia el rol a sí mismo.
- **EKKO-041 — La baja de una suscripción vieja no castiga al miembro.**
  `sync_membresia_stripe('cancelada')` solo toca `usuarios` si no hay otra
  membresía viva; y vuelve a soltar `membresia_tier` (fix de 0704 que se perdió
  al recrear la función el 0821).
- **EKKO-042 — Las cuentas demo no llevan contraseña fija.** `admin-seed-demo`
  genera una al azar por corrida y la devuelve una sola vez.
- **EKKO-043 — Una sola lista de eventos del webhook** (`scripts/stripe-eventos.mjs`)
  y un test que exige que coincida con los `case` de `clasificarEvento`.
  Se agregó `charge.refunded`.

## Paridad con SALA — Auditoría #2, Sprint C · dinero (2026-09-20)

- **EKKO-044 — Un pago único acredita una vez.** `activar_membresia` recibe
  `p_referencia` (id del PaymentIntent) y lo guarda en `membresias.referencia_pago`
  (único). La sesión de Checkout y su PaymentIntent son dos eventos del mismo
  pago: el segundo es no-op, aunque el paquete ya se haya reemplazado. El usuario
  se bloquea `FOR UPDATE` para serializar eventos simultáneos.
- **EKKO-045 — Recomprar nunca acorta.** Un paquete nuevo vence en la fecha más
  lejana entre la suya y la del saldo que arrastra. Una mensualidad de mostrador
  (sin Stripe) del MISMO plan renovada antes de vencer apila desde su fin actual;
  cambiar a otro plan no hereda días. Con Stripe manda Stripe.
- **EKKO-046 — La pausa cuenta como membresía viva.** Entra al índice único, al
  cierre/arrastre de `activar_membresia`, a la devolución de créditos y a las
  listas de las functions (cancelar, subs previas del webhook). Reanudar una
  membresía sin Stripe le devuelve los días que estuvo en pausa, y vuelve al
  status que tenía (`pausada_desde_status`): una `past_due` sigue debiendo.
- **EKKO-047 — Perder créditos exige confirmación en el servidor.**
  `p_confirmar_perdida` (default true para el webhook, que ya cobró); recepción
  manda false salvo confirmación → `EKKO_PERDERIA_CREDITOS` → 409 → la UI pregunta.
- **EKKO-048 — Un cobro no levanta una sanción.** `sync_membresia_stripe` solo
  reactiva a quien estaba sin acceso por PAGO (`cancelado`, `pendiente_*`) o por
  la pausa de esa misma membresía; nunca a un `suspendido`/`revocado` por el admin.
- **EKKO-049 — La devolución vuelve a la membresía que pagó** si sigue viva o en
  pausa; si ya se reemplazó, a la viva actual.
- **EKKO-050 — Recibido ≠ procesado.** `stripe_webhook_events.processed_at` se
  marca al terminar la acción de dinero (antes de contabilidad y avisos). Un
  reintento que encuentra la fila sin procesar y con más de 60 s la reclama con
  un UPDATE condicionado; si es más reciente responde 503. `sync` que devuelve
  `success:false` se reporta a Sentry (no relanza: reintentar no lo arregla).
- **EKKO-051 — A quien pagó no se le borra.** `admin-delete-user` responde 409
  si hay suscripción viva en Stripe, cobros registrados o huella de staff
  (check-ins, cancelaciones, notas, bitácora): se revoca, no se elimina.
- **EKKO-052 — `en_venta` se valida en el servidor** en las tres functions de
  cobro. La idempotencyKey de `prices.create` es un hash de todos sus parámetros
  (`llavePrecio`): editar un plan ya no bloquea sus altas 24 h.
- **EKKO-053 — Avisos de cobro.** Pago fallido: aviso in-app al miembro (lo
  empuja cron-push) + aviso al equipo, haya o no email. Compra de paquete:
  correo con saldo y vigencia. `stripe-pausar-membresia` ya no empuja inline (el
  aviso de la RPC lo reparte cron-push; llegaba dos veces). `fetch` a Resend con
  timeout de 5 s.
- **Sin cambio (decisión conservadora, pendiente de David):** cancelación tardía
  hecha por recepción sigue devolviendo el crédito y sin contar para el tope
  (M15); invitados extra pagados no se reembolsan al cancelar (M16).

## Paridad con SALA — Auditoría #2, Sprint D · operación diaria (2026-09-20)

- **EKKO-054 — La ficha decide por el estado de la MEMBRESÍA, no por
  `usuarios.status`.** `accionesDeMembresia()` (pura) dice qué ofrecer: sin plan →
  Asignar; vencida / sin créditos → Renovar; en pausa → Reanudar; vigente →
  cambiar, pausar, ajustar créditos, dar de baja. Con suscripción Stripe nunca se
  ofrece "Renovar" (se renueva sola). La membresía se carga UNA vez por ficha y
  baja a todas las tarjetas; tras cada acción se recarga todo junto.
- **EKKO-055 — Asignar / renovar / cambiar plan en un paso** (`AsignarPlanModal`),
  con motivo ("cómo pagó") obligatorio en la UI y registrado en `audit_log`.
  Sustituye a "Editar datos → elegir plan → guardar → Activar membresía".
- **EKKO-056 — `staff_ajustar_creditos`**: ±1..50, motivo ≥ 5 caracteres, saldo
  nunca < 0, asiento `ajuste` en el ledger, bitácora y aviso al miembro. Funciona
  también con la membresía en pausa.
- **EKKO-057 — `staff_cancelar_membresia` + function `staff-cancelar-membresia`.**
  Con suscripción: no se renueva (`cancel_at_period_end`) y conserva el acceso;
  Stripe primero y, si la RPC rechaza, se revierte. Inmediata (sin suscripción, en
  pausa, o pedida): RPC primero y `subscriptions.cancel` después, porque cancelar
  en Stripe no se deshace; si falla se reporta y lo recoge el reconciliador. Los
  créditos que se pierden quedan asentados. NO cancela las reservas futuras.
- **EKKO-058 — No-show durante la sesión.** Se puede marcar la falta desde
  `slot_inicio + reserva.ventana_check_in_min` (15 por defecto), no hasta que
  termine la hora: libera el estudio para un walk-in. El UPDATE va condicionado a
  `status='confirmada'` (no penaliza dos veces si el cron se adelantó).
- **EKKO-059 — La cancelación por el estudio queda en la bitácora** (trigger sobre
  `confirmada → cancelada_admin`; cubre recepción y el UPDATE directo de admin).
- **EKKO-060 — "Vigente" para el miembro = hasta 30 min después de `slot_fin`.**
  Inicio, Mis reservas y el acceso al QR filtran por `slot_fin` con la gracia del
  check-in: la sesión en curso ya no desaparece con su QR. Una sesión empezada no
  se puede cancelar.
- **EKKO-061 — El miembro cancela cualquiera de sus reservas**, no solo la próxima.
- **EKKO-062 — Fechas y horas del miembro en la zona del ESTUDIO** (hero, Mis
  reservas y su agrupación por día, QR, modal de cancelar, mensaje de WhatsApp,
  Reservar, restricción).
- **EKKO-063 — El plan actual se muestra aunque ya no se venda.** `MiSuscripcion`
  carga todos los planes y filtra lo comprable con `vendible`; el suscriptor de un
  plan retirado lo ve, con un aviso, y puede cancelarlo.
- **EKKO-064 — Tras pagar desde el Perfil se sondea la activación** (webhook) y se
  refresca el usuario: Reservar deja de decir "Necesitas un plan".
- **EKKO-065 — Reservar avisa ANTES** si el plan no incluye el estudio o hay una
  restricción; se quitó el sufijo "· Inténtalo otra vez".
- **EKKO-066 — Pausa ≠ sanción.** En el login, un miembro `suspendido` por la
  pausa de su membresía lee un mensaje propio; en la ficha de recepción no se
  muestra la alarma de "cuenta suspendida". (Decisión conservadora: sigue sin
  entrar a la app; el modo lectura queda pendiente de David.)
- **EKKO-067 — El banner de instalar no estorba:** solo landing e inicio del
  miembro, solo pantallas de teléfono, tras 4 s, por debajo de los modales y por
  encima de la barra de navegación; el descarte dura 90 días.
- **EKKO-068 — Push para el staff.** `ActivarAvisosPush` es compartido; admin
  (dashboard) y recepción (Hoy) lo ven como invitación hasta activarlo.

## Solicitud de cambios del cliente (2026-09-20)

Detalle en `docs/archive/SOLICITUD_CLIENTE.md`.

- **EKKO-069 — La disponibilidad se pide a `slots_ocupados()`, nunca a `reservas`.**
  RLS no deja a un miembro ver reservas ajenas (correcto), así que leer la tabla
  pintaba libres los horarios de otros. La RPC devuelve solo intervalos.
- **EKKO-070 — "Un solo set a la vez"** (`reserva.sets_exclusivos`) se hace cumplir en
  la base: trigger + `pg_advisory_xact_lock` por estudio. La grilla decide por
  TRASLAPE de intervalos (no por igualdad de hora) y distingue `otro_set`.
- **EKKO-071 — Disponibilidad "en tiempo real" por sondeo (20 s)**, no por Realtime:
  Realtime respeta RLS y no entrega cambios de reservas ajenas.
- **EKKO-072 — Calendario en el navegador**: `.ics` (con `data:`, no `blob:`, por la
  PWA de iOS) + enlace de Google. Horas en UTC; UID estable por reserva.
- **EKKO-073 — Correo = despachador central** (`cron-email` sobre
  `notificaciones.email_enviado_at`), mismo patrón que el push. Lista blanca de tipos.
  Sin Resend no marca nada. Todo el texto del aviso se escapa (también el preheader).
- **EKKO-074 — La confirmación de reserva nace en un trigger** de `reservas` (cubre la
  app y recepción). Fechas de los avisos con `_fecha_hora_estudio()`.
- **EKKO-075 — Material = archivo o enlace**, ligado a la reserva, con vigencia que
  también rige en Storage. Un aviso por tanda. Subida directa ≤ 500 MB.
- **Apple Pay / Google Pay**: sin código; dominio registrado en la CUENTA CONECTADA
  (`scripts/stripe-wallets-dominio.mjs`).

## Restos de la solicitud del cliente + Sprint E (2026-09-20)

- **EKKO-076 — Reprogramar = un solo aviso de "cambio de horario".** **[SUSTITUIDA por EKKO-122]**
  `staff_avisar_reprogramacion` retira el par agendada + cancelada recién creado y
  deja uno con de-dónde-a-dónde. Best-effort: si falla, quedan los dos originales.
- **EKKO-077 — La ficha ADMIN del miembro usa la misma tarjeta y modales de
  membresía que recepción.** El plan ya no se edita en un select + "Guardar" +
  "Activar manualmente". El status de la cuenta va por `reception-update-member`
  (motivo obligatorio + bitácora), con etiquetas humanas. Material por sesión.
- **EKKO-078 — El admin cancela reservas por `cancelar_reserva_atomic`**, no con un
  UPDATE. Se quitó la opción de cancelar sin avisar al miembro. El dashboard solo
  ofrece "Cancelar" en reservas confirmadas que no han empezado, y "Ver detalle"
  abre el modal (antes era un toast de desarrollo).
- **EKKO-079 — El centro de pendientes lleva a listas ya filtradas**
  (`/admin/miembros?status=…` / `?filtro=vencidas|identidad`).
- **EKKO-080 — Reset de contraseña del equipo desde Admin → Equipo.**
- **EKKO-081 — La campana es un historial** (20 avisos, leídos atenuados), "marcar
  todas" es una sola sentencia, revierte si el servidor falla, y navega a
  `metadata.url` (solo rutas internas). El aviso `cambiar_password` no se puede
  descartar desde la campana: es lo que mantiene encendido el gate.

## "Pago por hora" en un solo flujo (2026-09-21)

- **EKKO-082 — Elegir la hora primero; el paquete se compra ahí mismo.** Sin plan o
  sin saldo, tocar una hora ofrece `elegirPaquetePorHora()` (el paquete de créditos
  más barato que, con el saldo actual, alcanza para ESE estudio y que el estudio
  acepta; nunca una mensualidad ni un plan retirado). Al pagar, se sondea la
  acreditación (webhook, ≤ 30 s) y se reserva la hora sola; si se ocupó mientras
  tanto, los créditos quedan y se elige otra.
- **Bug corregido de paso:** `useVisibilityAwarePolling` ejecuta `poll` al montar y
  cada vez que cambia su identidad; en Reservar se le pasaba una arrow inline →
  bucle infinito de recargas de la grilla. Ahora es un `useCallback` estable que
  ignora el primer tick. Lo atrapó el test de render de la página.

## Endurecimiento de base + índices + e2e (2026-09-21)

- **EKKO-083 — Nadie deja el estudio sin admin activo** (trigger en `usuarios`,
  UPDATE y DELETE, aplica también a service_role y al SQL editor). El miembro
  tampoco toca `email`, `auth_id`, `membresia_activa_id`, `notas_admin` ni
  `invitado` sobre su propia fila (sí nombre y teléfono).
- **EKKO-084 — Ledgers inmutables por trigger**, no solo por RLS: `audit_log`
  nunca se modifica ni se borra; `membresia_movimientos` solo admite el SET NULL
  de `reserva_id` (FK) y el DELETE en cascada al borrar la membresía. Para
  corregir un saldo se registra un ajuste.
  `_estado_membresia_checkin` ya no es ejecutable por `authenticated` (un miembro
  podía consultar el estado de otro por UUID).
- **EKKO-085 — Los checks de `supabase/tests/*.sql` corren en CI**
  (`src/__tests__/db/checks-sql.db.test.ts`) en vez de pegarse a mano. Índices
  parciales para recordatorios / no-shows y por usuario, PaymentIntent y fecha en
  `payment_events` y el ledger. Smokes e2e reales (landing, móvil, login, signup,
  404, /app sin sesión) en lugar del placeholder; el job sigue gateado por
  `RUN_E2E` hasta que existan los secrets.

## Restos del Sprint D de la paridad SALA (2026-09-21, tarde)

- **EKKO-086 — "Editar datos" en recepción es SOLO contacto** (nombre, teléfono,
  email). Poner `status='activo'` o un plan a mano sin cobrar era la puerta trasera
  que la auditoría #1 cerró en admin (P0-7) y aquí seguía abierta (R5). El plan se
  activa con dinero (`MembresiaCard`) y el estado de la cuenta se cambia con motivo
  (`EstadoCuentaCard`). El servidor (`reception-update-member`) sigue aceptando
  `status` con motivo porque esa tarjeta lo usa.
- **EKKO-087 — Atajos de mostrador en Hoy (R7):** check-in de UN toque desde
  "Llegando ahora" (mismo RPC y mismo `CheckInDetail` después: el aviso de
  membresía vencida no se pierde), cancelar la reserva desde la tarjeta (solo
  confirmadas que no empezaron; el RPC deja `cancelada_admin` y avisa), búsqueda por
  TELÉFONO en Hoy y en el padrón (`lib/buscarEnPadron.ts`, últimos dígitos, con o
  sin formato), foto o iniciales en las tarjetas y aviso "Ficha o contrato
  pendiente" antes de que llegue.
- **EKKO-088 — El historial de pagos dice QUÉ se cobró** (A11):
  `conceptoDeCargo()` en `stripe-billing-info` resuelve "Paquete · 4 horas",
  "Renovación de membresía · Esencial", "Invitados extra (2)" a partir de la
  metadata del cargo o de la invoice expandida; trae `receipt_url` (enlace "Ver
  recibo") y los reembolsos: un cargo devuelto se muestra "Reembolsado", uno
  parcial "Devuelto $X". Antes un cargo reembolsado decía "Pagado".
- **EKKO-089 — "Contacta al estudio" con enlace de verdad** (A12):
  `ContactoEstudio` abre el WhatsApp del estudio con el mensaje ya escrito (login
  con cuenta no activa, restricción activa en Inicio, sin estudios al reservar,
  cancelación con invitados pagados). Sin número configurado no pinta nada; sin
  `TenantProvider` tampoco truena (`useTenantOpcional`). Los Términos ya no prometen
  "reprogramar": la app cancela y vuelve a reservar; con menos anticipación se acuerda
  con el estudio.
- **EKKO-090 — Cancelar con invitados extra pagados avisa** (M16, parte "aviso"):
  el modal dice cuántos invitados se cobraron, que ese cobro NO se devuelve solo, y
  da el WhatsApp con el folio. El reembolso automático sigue siendo decisión de
  David (M16 dinero). **A8 en la sesión abierta:** `MemberLayout` distingue pausa de
  sanción ANTES de cerrar la sesión (con la sesión viva aún puede leer sus
  membresías) y manda a /login con `MENSAJE_EN_PAUSA`; el mensaje se resuelve antes
  del redirect genérico para que `signOut` no se lo coma.
- **De paso, e2e:** Playwright corre `npm run dev` en un puerto propio (5187). Con
  el 5173 compartido el smoke corría contra el dev server de SALA que estaba abierto
  en esta máquina y pasaban 5 de 6 pruebas por casualidad. `/signup` sin `?tier=`
  redirige al landing (eso es lo que se prueba); el alta se prueba siguiendo un plan
  real del landing y se salta si el entorno no tiene planes en venta.

## Identidad única · Fase 1 — data safety + invariantes de acceso (2026-09-25)

Origen: auditoría maestra de identidad (misma sesión). Veredicto PARTIAL: una sola
entidad persona (`usuarios`) y un solo embudo de alta, pero estado de membresía
copiado en `usuarios`, correo en tres sistemas y resolución de identidad solo por
email exacto en Auth. Esta fase corrige lo que podía PERDER datos o dar acceso
indebido; la desnormalización membresía ↔ usuarios queda para la Fase 2.

- **EKKO-091 — Sanción administrativa ≠ estado comercial.** `usuarios.sancionado_at`
  + `sancion_motivo`. MEMBRESÍA dice si tiene plan/créditos/vigencia; SANCIÓN dice si
  el estudio le permite usar el servicio. Trigger `trg_sancion_manda`: mientras haya
  sanción el status se fuerza a `suspendido`, la escriba quien la escriba
  (`activar_membresia`, reanudar pausa, `sync_membresia_stripe`, cambiar-plan…); y una
  operación de membresía nunca saca a nadie de `revocado`. Stripe informa el estado de
  la SUSCRIPCIÓN; no tiene autoridad sobre la sanción. Suspender desde el mostrador
  (`reception-update-member`) fija la sanción con motivo; activar o dejar pendiente de
  pago la levanta, en el mismo UPDATE y auditado. `suscribir-membresia` y
  `crear-pago-intent` rechazan (403) a sancionados y revocados: el cobro crearía la
  membresía y la cuenta seguiría suspendida. Backfill: miembro `suspendido` sin
  membresía `pausada` = sanción (la pausa deja `membresias.status='pausada'`).
  Pendiente de Fase 2: `status` sigue siendo copia; un sancionado cuya suscripción se
  cancela conserva `suspendido` y al levantarle la sanción queda `activo` sin plan (el
  trigger de reserva exige membresía viva, así que no reserva).
- **EKKO-092 — Ficha de identidad por PATCH.** `reception-datos-identidad`: campo
  ausente o vacío conserva; texto actualiza; `null` es borrado explícito (la UI no lo
  manda); la INE no reenviada se conserva; sin cambios no se escribe. Antes un campo
  omitido quedaba en NULL y una carga fallida del modal borraba fecha de nacimiento,
  domicilio e INE. El modal no permite guardar si la ficha actual no cargó (error +
  reintentar) y envía solo lo que cambió.
- **EKKO-093 — `contrato_firmado_at` es un evento histórico.** false→true fija la
  fecha; true→true no la toca; true→false se ignora y se reporta (quitar una firma
  exige una operación propia y auditada, no un checkbox). El modal muestra el contrato
  firmado bloqueado.
- **EKKO-094 — `avatar_url` es evidencia de identidad, no cosmético.** Forma parte de
  `identidad_completa` (foto + nacimiento + domicilio + INE) y el miembro podía
  cambiársela por PostgREST tras la verificación. Ahora `avatar_url`,
  `contrato_firmado_at`, `sancionado_at` y `sancion_motivo` son columnas privilegiadas
  (solo staff por función o admin). `identidad_completa` se recalcula por trigger al
  cambiar la foto o la ficha (cualquier ruta, incluida la foto que admin sube por RLS).
  Para la Fase 2: separar foto de perfil (cosmética) de foto de identidad (evidencia).
- **EKKO-095 — El alta en Auth vincula, no ignora.** `handle_new_auth_user` con correo
  normalizado (lower/trim): sin fila → INSERT; una fila del mismo tenant sin `auth_id`
  → LINK (+ audit `auth_vinculado`); una fila ya vinculada a otra cuenta o varias filas →
  excepción `EKKO_IDENTIDAD_AMBIGUA` (el alta en Auth se revierte; nunca se roba un
  `auth_id`). `admin-create-user` ya no responde éxito si el perfil final no existe:
  borra la cuenta de Auth y avisa. `fake-signup` normaliza el correo en el servidor.
- **EKKO-096 — Correo único por estudio sin importar mayúsculas** (índice
  `usuarios_tenant_email_lower_uniq`, migración aparte `20260925110000`): se crea SOLO
  si no hay duplicados por capitalización; si los hay, avisa y no se aplica. El precheck
  de producción es `supabase/precheck_identidad_fase1.sql` (solo SELECT).
- **EKKO-097 — `reception-update-member` ya no acepta `membresia_tier`** (400). Era la
  única ruta genérica capaz de conceder o quitar acceso comercial escribiendo la copia
  derivada; el plan se activa con cobro (`activar_membresia`) o se da de baja con
  `staff_cancelar_membresia`.

## F2 · R1 — invariantes de membresía y observabilidad (2026-09-27)

Origen: auditoría F2 de estado de membresía (solo lectura). R1 es quirúrgico: no
introduce el derecho canónico (R2) ni cambia el contrato externo de
`activar_membresia`. Migración `20260927100000_r1_invariantes_membresia.sql`;
tests en `src/__tests__/db/r1-invariantes.db.test.ts` (34 casos; 26 fallan sin la
migración).

- **EKKO-098 — P0-1: la cuenta manda sobre una reserva ya pagada.**
  `_estado_membresia_checkin` evalúa revocación y sanción ANTES del atajo "la sesión
  ya se pagó con créditos". El crédito no se vuelve a descontar (cambia la
  autorización, no la historia del pago). La pausa (suspendido sin sanción) conserva
  su comportamiento: con reserva ya pagada, entra. `qr-issue` no entrega QR a
  cuentas revocadas o sancionadas (defensa en profundidad; la puerta sigue siendo la
  autoridad).
- **EKKO-099 — Check-in manual (decisión final de David, 2026-09-27).** REVOCADO:
  bloqueado también en mostrador (trigger `trg_bloquear_checkin_revocado`, BEFORE:
  rechaza con `EKKO_CUENTA_REVOCADA` y no queda ningún check-in; cubre también la
  corrección "sí asistió"). SANCIONADO: recepción puede dar ingreso como excepción;
  el RPC devuelve `cuenta_sancionada`, la ficha muestra el aviso y un trigger deja
  `checkin_manual_con_restriccion` (actor, reserva, `override: true`). El intento
  rechazado de un revocado no se audita (el rechazo revierte la transacción).
- **EKKO-100 — Revocación persistente.** `trg_sancion_manda` mantiene `revocado`
  frente a cualquier UPDATE (activación, sync de Stripe, pausa/reanudación, baja
  inmediata, admin por RLS). La única vía es `restaurar_acceso_revocado` (service
  role; actor admin activo; motivo; audit `acceso_restaurado`), que usa
  `reception-update-member` cuando un admin cambia el estado de una cuenta revocada.
  Recepción recibe 403. Una sanción vigente sigue mandando tras la restauración.
- **EKKO-101 — Stripe no resucita membresías.** `sync_membresia_stripe` no toca una
  membresía `cancelada` o `expirada`; si Stripe la reporta viva, registra
  `stripe_estado_contradictorio` y responde éxito (sin reintentos infinitos ni la
  violación del índice de una sola viva). Toma `FOR UPDATE` sobre la membresía. El
  orden descarta solo eventos ESTRICTAMENTE más viejos; dos eventos distintos del
  mismo segundo se aplican en orden de llegada (la idempotencia la da el id del
  evento en `stripe_webhook_events`; `event.created` tiene resolución de 1 s y no
  permite un orden total dentro del mismo segundo).
- **EKKO-102 — Facturas basil y atribución.** Con la API `2025-08-27.basil` (SDK
  18.5) la factura trae la suscripción en `parent.subscription_details` y el PI en
  `payments.data[].payment`; el PI y el cargo ya no traen `invoice`. Extractor
  compatible con ambas formas. Un `payment_intent.succeeded` solo se registra si lo
  creó EKKO (`metadata.app = 'ekko'`): así el PI de una factura de suscripción no se
  cuenta dos veces. `payment_events` recibe `membresia_id`, usuario y tenant solo por
  vía determinista (la membresía creada o la dueña de la suscripción). Sin
  backfill de los 14 eventos históricos (R5).
- **EKKO-103 — Auditoría del ciclo de vida con el estado real.** Triggers AFTER en
  `usuarios` (status, rol, sanción → `cuenta_estado_cambio`) y `membresias` (alta,
  status, plan → `membresia_estado_cambio`), con el actor de la sesión o `sistema`.
  `staff_pausar_membresia`, `reception-activar-membresia` y `reception-update-member`
  registran el estado persistido, no el pedido.
- **EKKO-104 — `v_reconciliacion_membresia`.** Vista de solo lectura con
  `security_invoker` (respeta RLS y tenant). `divergencias`: activo sin derecho,
  tier sin membresía viva, membresía viva sin id, id inválido, tier distinto,
  membresía vencida sin expirar, varias vivas, contradicción de Stripe, customer
  distinto. `restricciones`: revocado o sancionado con membresía viva (la membresía
  se conserva). No repara nada.

## Remediación por paquetes — dinero y evidencia (PKG-01A a 01H, 00F, 02A, 02B · 2026-09-28 a 10-03)

Desde aquí el trabajo va por paquetes (`PKG-…`). Cada entrada conserva la etiqueta
con la que el dueño tomó la decisión (`D7`, `W-1`, `D-01F-4`…): así aparece en los
comentarios del código, las migraciones y las pruebas.

- **EKKO-105 — PKG-01A · Un evento de Stripe tiene estado durable.**
  `stripe_webhook_events` responde qué llegó, qué debía pasar y cómo terminó
  (`en_proceso | procesado | ignorado | error_reintentable | revision`).
  `claim_stripe_event` es la única puerta: un `event.id` → una sola reclamación
  activa. `D-01A-1`: ante la duda el error es transitorio; `revision` no es un
  cajón de sastre. Lo histórico queda marcado `legacy_backfill_*`, no reinterpretado.
  Migración `20260928100000`; `src/__tests__/db/stripe-eventos.db.test.ts`.
- **EKKO-106 — PKG-01B · Crear un Checkout no da derecho.** El derecho nace del
  evento FINANCIERO: `checkout.session.completed` solo activa con
  `payment_status = 'paid'`; si no, llega por `payment_intent.succeeded` (paquete)
  o `invoice.paid` (mensual). Un `subscription.updated` sin membresía todavía no es
  divergencia. `netlify/functions/suscribir-membresia`, `stripe-webhook`.
- **EKKO-107 — PKG-01C · Idempotencia de lo que EKKO le pide a Stripe.** Cada
  operación saliente lleva un `operation_id` del cliente y una llave estable
  (`ekko:v1:…`); un reintento encuentra y clasifica el objeto ya creado en vez de
  crear otro. `netlify/functions/_lib/operacionPago.ts`.
- **EKKO-108 — PKG-01D · Venta de mostrador con evidencia.** Ningún éxito
  financiero sin evidencia durable: `ventas_mostrador` guarda el precio aplicado y
  `registrar_venta_mostrador` es atómica e idempotente por `operation_id`. `D9`:
  efectivo/transferencia/terminal cobran el precio de lista, cortesía cobra 0.
  `D-01D-3`: una suscripción de Stripe viva rechaza la venta (no se cancela nada).
  `D-01D-5`: sin `operation_id` o sin método no hay venta; nada de defaults.
  Migración `20260930100000`; `ventas-mostrador.db.test.ts`.
- **EKKO-109 — PKG-01E · Tarjeta en mostrador = mismo cobro de Stripe.** El
  servidor deriva el importe del catálogo (el cliente no manda montos) y marca el
  pago con `metadata.origen = 'mostrador'`. `D-01E-4`: una suscripción viva no se
  sustituye ni se duplica desde mostrador. `netlify/functions/mostrador-crear-pago`.
- **EKKO-110 — PKG-01F · Cambio de plan con guard y transición atómica.**
  `D12 / D-01F-4`: si el plan destino deja inválidas reservas futuras, el cambio se
  RECHAZA y se listan; no se cancela ni se reembolsa nada automáticamente.
  `cambiar_tier_membresia` mueve membresía y caché juntos, idempotente por
  `operation_id`, con rastro en `audit_log`. `D-01F-5`: mensual con suscripción →
  paquete sustituye la mensualidad y pierde el resto del periodo, sin reembolso, con
  aviso previo. `D-01F-6`: perder créditos exige consentimiento en el servidor al
  crear el cobro. `D-01F-7`: solo una membresía `activa` se re-precia.
  Migración `20260930120000`; `cambio-de-plan.db.test.ts`.
- **EKKO-111 — PKG-00F · El correo dice la verdad.** `email_resultado` distingue
  `aceptado` (Resend aceptó, hay id), `sin_correo` y `fallo`. ACEPTADO POR EL
  PROVEEDOR ≠ ENTREGADO. Sin reintentos aquí. Lo anterior a 00F queda con
  resultado NULL, sin reinterpretar. Migración `20261001100000`;
  `email-resultado.db.test.ts`.
- **EKKO-112 — PKG-01G · `D7`: un reembolso no muta derechos.** Deja evidencia
  exacta con identidad propia (`reversales_pago`, una fila por objeto `re_…`,
  inmutable), atribuida a su pago de origen solo si se puede demostrar, abre una
  revisión humana (`revisiones_financieras`) y avisa al admin. CERO cambio
  automático de créditos, membresía, cuenta, plan, reservas o suscripción. Origen
  ambiguo → revisión, nunca adivinado. **Sustituye a EKKO-028.**
  Migración `20261002100000`; `reversales.db.test.ts`.
- **EKKO-113 — PKG-01G · `D8`: disputas.** Abierta: evidencia + revisión + aviso.
  Ganada: se asienta y cierra la revisión. Perdida: se asienta y queda en revisión.
  Sin mutación automática de derechos.
- **EKKO-114 — PKG-01G · `D-01G-3`: desautorización de Connect.** Apaga la
  capacidad de COBRO del estudio y conserva `stripe_account_id`
  (`tenants.stripe_desconectado_at`). Nunca toca el derecho de un miembro.
- **EKKO-115 — PKG-01G · `D-01G-4`: proveniencia del valor, hacia adelante.**
  `membresia_movimientos.origen` se clasifica al nacer el movimiento; lo histórico
  queda explícitamente `desconocido`. No se fabrica atribución con backfill.
- **EKKO-116 — PKG-01H · `W-1 = B`: `capacidad_personas` es informativa.** No
  limita reservas ni invitados.
- **EKKO-117 — PKG-01H · `W-2 = A`: un pago de extras que no puede aplicarse no
  desaparece.** Queda como evidencia `no_aplicado` con motivo + una revisión
  financiera; el evento se da por procesado. Sin reembolso ni derecho automáticos.
- **EKKO-118 — PKG-01H · `W-3 = A`: la RESERVA es la verdad de sus invitados.** Un
  PaymentIntent → a lo más una aplicación (`invitados_extra_pagos`, inmutable);
  `reservas.invitados_extra_pagados` es caché de esa evidencia; las fichas de
  recepción no pasan de incluidos + extras pagados. Migración `20261003100000`;
  `invitados.db.test.ts`.
- **EKKO-119 — PKG-02A · Estados de error honestos.** Un fallo al cargar nunca se
  muestra como "vacío" ni como éxito: se dice que no se pudo comprobar y se ofrece
  reintentar; no se asume 0 ni "sin datos".
- **EKKO-120 — PKG-02B · La interfaz no afirma dinero ni derecho antes de verlo.**
  Tras un pago se OBSERVA el efecto en el servidor (activación, extras); no se suma
  en memoria ni se declara "pagado". El plan "actual" sale de la membresía viva.

## R2-A — reservas, asistencia y autoridad (PKG-01I a 01M · 2026-10-03)

Migración `20261004100000`; `src/__tests__/db/r2a-reservas.db.test.ts`.

- **EKKO-121 — PKG-01I · Las transiciones de asistencia son del servidor.** "Sí
  asistió" solo desde `no_show` con la sesión ya iniciada; "deshacer check-in" solo
  desde `completada` y el mismo día (`staff_corregir_asistencia`). Una reserva
  CANCELADA no se revive: se crea otra. La corrección no mueve créditos. La guarda
  de identidad aplica a cualquier entrada a `completada`. **Sustituye a EKKO-025.**
- **EKKO-122 — PKG-01J · Reprogramar es UNA operación atómica.**
  `reprogramar_reserva` cancela, recrea, traslada extras pagados (con rastro en
  `invitados_extra_traslados`; la evidencia del pago no se reescribe) y fichas, deja
  un solo aviso y audita. Si algo falla, la original queda intacta. El navegador no
  orquesta transiciones de varios pasos. **Sustituye a D6 y a EKKO-076.**
- **EKKO-123 — PKG-01K · El plan que da derechos es el de la membresía VIVA.**
  `usuarios.membresia_tier` es caché de display; las RPC usan `_tier_vivo`.
- **EKKO-124 — PKG-01L · Ser admin de la fila no autoriza a mutar sus invariantes.**
  Sin escritura directa por REST en reservas, membresías ni datos privados; el
  admin no cambia por REST plan, puntero de membresía, penalización, sanción, rol,
  correo ni contrato de un usuario. Esos cambios van por RPC o función de servidor.
- **EKKO-125 — PKG-01M · Semántica de planes protegida.** El slug es inmutable;
  tipo y "activo" no cambian con membresías vivas; `reglas.max_invitados` es
  obligatorio (entero ≥ 0), sin defaults por slug.

## R2-B — libro económico, terminación, cobro y cancelación (PKG-01N a 01Q · 2026-10-05)

Migraciones `20261005100000` y `20261005110000`; pruebas
`r2b-libro-economico.db.test.ts`, `r2b-terminacion.db.test.ts` y
`src/__tests__/operacionesSuscripcion.test.ts`.

- **EKKO-126 — PKG-01N · Libro económico: una lectura, no otra contabilidad.**
  `v_libro_economico` compone la evidencia existente. BRUTO = cobros firmes, una
  vez cada uno (Stripe y mostrador). REVERSADO = reembolso efectuado o disputa
  perdida, por su monto exacto, solo con pago de origen resuelto y firme. NETO =
  suma de efectos. Lo no atribuible queda `sin_resolver`, visible y fuera del neto;
  no se fabrica atribución histórica. No resta comisiones de Stripe (no se guardan).
  **Sustituye a EKKO-034.**
- **EKKO-127 — PKG-01O · `D-01O-1 = B`: crédito que no se puede restaurar.** Si
  al cancelar hay que devolver un crédito y ya no existe membresía viva con saldo
  donde ponerlo, NO se pierde en silencio, no se crea ni se resucita una membresía
  y no se reembolsa dinero: queda evidencia + UNA revisión `credito_no_restaurado`
  + aviso al admin. La resolución es humana.
- **EKKO-128 — PKG-01O · `D-01O-2 = A`: no se reserva después del fin efectivo
  conocido del derecho.** Lo rechaza el servidor (`trg_reserva_dentro_de_vigencia`).
  Aplica a planes por TIEMPO con fin conocido (baja al fin de periodo, o mensual de
  mostrador). Una suscripción que se renueva no tiene fin conocido. Una sesión
  pagada con crédito queda pagada al reservar y no se bloquea. Y no se penaliza una
  falta que EKKO mismo hizo imposible (cuenta sancionada o revocada, derecho
  terminado): la reserva queda `no_show` sin contador, bloqueo ni aviso.
  La baja sigue SIN cancelar reservas futuras (EKKO-057).
- **EKKO-129 — PKG-01P · `D-01P-1 = B`: la sanción suspende el cobro.** Sanción =
  temporal: se pausa el cobro de Stripe con el mecanismo reversible existente
  (`pause_collection`) y se reanuda al levantarla solo si la cuenta no está
  revocada y la membresía y la suscripción siguen vigentes. Nunca se cancela una
  suscripción solo por sanción. Sin reembolso automático.
- **EKKO-130 — PKG-01P · `D-01P-1 = B`: la revocación cancela de inmediato.**
  Revocación = terminal: la suscripción se cancela en Stripe ya, no al fin del
  periodo, sin reembolso automático. La revocación sigue siendo persistente
  (EKKO-100) y ningún cobro posterior la revierte (EKKO-101).
- **EKKO-131 — PKG-01P · Lo que EKKO debe hacer en Stripe queda escrito.** Cada
  suspensión, reanudación o cancelación es una fila de
  `stripe_operaciones_suscripcion`, creada en la MISMA transacción que la sanción,
  la revocación o la baja, con identidad de negocio única y llave por intento. Si
  Stripe falla, el estado de EKKO no se deshace: la operación queda `fallida`, se
  avisa al admin y se reintenta. **Complementa a EKKO-057** (antes: solo Sentry).
- **EKKO-132 — PKG-01Q · `D-01Q-1 = A`: la cancelación dice quién la causó.**
  `cancelar_reserva_atomic(…, p_causa)`: el equipo debe indicar `miembro` o
  `estudio`. Miembro a tiempo → crédito devuelto. Miembro tarde → se cancela y el
  crédito NO vuelve; el aviso lo dice. Estudio → el crédito vuelve (o EKKO-127).
  El miembro, por su cuenta, solo cancela a tiempo. Plan mensual: no se fabrica
  ningún movimiento. Ninguna cancelación genera reembolso en dinero.
- **EKKO-133 — PKG-01Q · Una sola ventana de cancelación.** Fuente única en el
  servidor (`_cancelacion_min_horas`): la configuración del estudio; si falta, 24
  horas. A tiempo = faltan MÁS de N horas; exactamente N o menos = tarde. La
  interfaz representa esa regla, no la define. **Sustituye el default de EKKO-015.**
- **EKKO-134 — PKG-01Q · `D-01Q-2 = A`: extras pagados en una reserva cancelada.**
  UNA revisión financiera `extras_pagados_reserva_cancelada`; sin reembolso
  automático; pagos, traslados y reversales no se tocan. Reprogramar traslada los
  extras y no abre revisión. **Extiende a EKKO-090.**
- **EKKO-135 — `D-R2B-GATE-1 = A`: una prueba que levanta una base lleva límite
  explícito.** La prueba del backfill de eventos de Stripe usa el mismo límite de
  120 s que las demás suites que levantan una base. No se inflan timeouts de forma
  general ni se debilitan pruebas para obtener verde.
- **EKKO-136 — PKG-02C · El gate `cambiar_password` es del servidor.** El aviso
  `cambiar_password` lo cierra únicamente el cambio REAL de contraseña en
  `auth.users` (trigger `on_auth_user_password_changed`). El cliente no lo apaga
  marcándolo leído, ni uno a uno ni con "marcar todas" (se conserva sin error); el
  frontend no escribe ese estado, solo vuelve a consultar. Si el mecanismo falla, el
  cambio de contraseña no se revierte y el aviso queda abierto: nunca un falso
  "contraseña cambiada". El resto de avisos: el cliente solo marca leído/no leído lo
  propio; contenido y evidencia de envío son del servidor y nadie crea avisos por
  REST. Notas de miembro: autor y rol se derivan de la sesión y de `usuarios`, y
  son inmutables. `anon` (y PUBLIC) sin escritura ni EXECUTE en funciones de
  aplicación; `authenticated` sin DML donde ninguna política lo autoriza y sin
  TRUNCATE. **Extiende a EKKO-124 y EKKO-039.**
- **EKKO-137 — PKG-03A · Pendientes operativos y entrega.** La notificación es el
  outbox del correo: intentos (máx. 3), backoff (2 y 10 min) solo para lo
  transitorio (timeout, red, 5xx, 429), terminal con motivo sin PII; lo que salió
  de la ventana sin intentarse queda `fallo` visible, no se pierde. El push se
  asienta DESPUÉS de intentar (`push_resultado`; `push_enviado_at` solo si salió).
  Los correos directos del webhook dejan evidencia en `correos_directos` (misma
  Idempotency-Key, sin destinatario). Eventos de Stripe y operaciones de cobro se
  cierran por RPC de admin con nota y auditoría, sin reescribir la evidencia;
  las operaciones de cobro tienen tope de 5 intentos automáticos por ronda y
  reintentar abre una ronda sobre la MISMA operación. `v_pendientes_operativos`
  solo deriva de las autoridades (admin de su estudio). Leído ≠ resuelto.
  **Extiende a EKKO-111, EKKO-131 y EKKO-105.**
- **EKKO-138 — `D-03A-1 = A`: una pausa del staff es independiente de la sanción.**
  Levantar una sanción NO reanuda el cobro si sigue vigente una pausa comercial
  puesta por el staff; el cobro solo vuelve con la transición explícita de
  reactivar. `membresias.status = 'pausada'` también llega como eco de la
  suspensión por sanción (Stripe `pause_collection` → webhook → sync), así que la
  intención vive aparte: `membresias.pausa_comercial_at`, que solo escribe
  `staff_pausar_membresia` (el webhook no la crea ni la borra). Al levantar la
  sanción con la intención vigente queda una `reanudar_cobro` DESCARTADA con motivo
  `pausa_comercial_vigente` (evidencia y cierre del ciclo). Sin backfill: la
  autoridad empieza hacia adelante. **Extiende a EKKO-066 y EKKO-129.**
- **EKKO-139 — EKKO-138 · Reactivar durante una sanción no reanuda el cobro.**
  Reactivar quita la intención de pausa comercial y la membresía vuelve a su
  estado, pero el acceso sigue bloqueado (la sanción manda) y el cobro sigue
  suspendido por la sanción (se re-asegura su suspensión; Stripe no se toca); el
  cobro vuelve al levantar la sanción. Pausar estando ya en pausa por el
  proveedor solo declara la intención. Pausar y reactivar son idempotentes. La
  revocación no cambia (contrato R1). **Extiende a EKKO-138 y EKKO-129.**
- **EKKO-140 — PKG-03B · `D-03B-1 = A`: el reconciliador de Stripe solo DETECTA.**
  Compara lo que EKKO espera (membresía viva/terminada, plan, sanción, revocación,
  intención de pausa comercial) con lo que Stripe contiene (existencia, estado,
  `pause_collection`, `cancel_at_period_end`, `metadata.tier_id`) y deja evidencia
  en `discrepancias_stripe`: una abierta por (estudio, suscripción, tipo); la cierra
  solo una corrida COMPLETA que ya no la ve (`convergio`); reaparecer = episodio
  nuevo; revisarla no la cierra. Parcial o fallida nunca cierra ni afirma "falta".
  No repara nada: Stripe solo se lee (`accounts.retrieve`, `subscriptions.list`).
  La cancelación automática de huérfanas de 48 h existente no cambia y lo que su
  ventana cubre no se reporta. Alcance: cuentas de `tenants.stripe_account_id`,
  suscripciones con `metadata.app = 'ekko'` o referidas por una membresía.
  **Extiende a EKKO-131, EKKO-137 y EKKO-138.**
- **EKKO-141 — PKG-02H · Las operaciones de cobro del staff son durables.** Pausar,
  reactivar y dar de baja al fin del periodo escriben su operación en
  `stripe_operaciones_suscripcion` en la MISMA transacción que la transición local
  (causas `pausa_staff`, `reactivacion_staff`, `baja_fin_periodo`; tipo nuevo
  `cancelar_fin_periodo`), con identidad por operación lógica (una pausa = una
  operación; una reactivación por pausa levantada; una baja programada por
  membresía). La función de Netlify ya no toca Stripe primero: RPC → ejecutor, el
  orden de R2-B. Si Stripe falla o es ambiguo, EKKO no se deshace: la operación
  queda `fallida`, visible en Operación, y se reintenta con la misma identidad; un
  reintento del mismo acto no produce un segundo efecto. El ejecutor revalida por
  causa: una pausa ya reactivada se descarta (`reactivada`); una reactivación con
  sanción vigente o pausa comercial vigente se descarta. La sanción solo descarta
  SUS suspensiones y no duplica una reanudación en espera. **Matiz a EKKO-138:** el
  marcador `reanudar_cobro` descartado `pausa_comercial_vigente` se deja solo cuando
  lo último aplicado es la suspensión POR SANCIÓN; si lo último aplicado es la pausa
  del staff, su propia operación es la evidencia. **Extiende a EKKO-131, EKKO-138,
  EKKO-139 y EKKO-057.**

## PKG-06A — operaciones compuestas de cuenta (2026-10-06)

- **EKKO-142 — PKG-06A · `D-FIN-1 = A`: las operaciones compuestas de cuenta tienen
  frontera del servidor.** Alta (admin y recepción), cambio de rol, baja, reset de
  contraseña y edición por staff corrían como Auth Admin API + escrituras sueltas con
  service_role + auditoría best-effort (actor NULL/'sistema'). Ahora la parte LOCAL de
  cada una es UNA transacción en una RPC de servicio con actor explícito validado
  (`cuenta_alta_preparar`/`cuenta_alta_finalizar`, `cuenta_cambiar_rol`,
  `cuenta_eliminar`, `cuenta_password_reseteada`, `staff_actualizar_cuenta`), solo
  ejecutable por service_role (el actor no se forja), que publica ese actor en la
  transacción para que la auditoría de R1 lo registre. No se afirma atomicidad con el
  proveedor de Auth: hay orden seguro (preparar → Auth → finalizar; Auth → copia local
  del correo), compensación por PROPIEDAD (solo se revierte la cuenta de Auth cuyo
  perfil creó esa misma alta; un perfil preexistente nunca se borra como rollback) y
  respuesta parcial honesta cuando una mitad quedó hecha, con reintento que converge.
  **El correo no prueba identidad:** el alta en Auth vincula un perfil sin acceso solo
  si no tiene historial durable (cascarón; EKKO-095 sigue valiendo para él) o si un
  staff autorizó el acceso sobre ESE perfil (`acceso_autorizado_at/por`, consumido al
  vincular); con historial y sin autorización el alta se rechaza
  (`EKKO_PERFIL_CON_HISTORIAL`). Al vincular no se reescriben rol, status ni plan.
  **D-FIN-1 = A:** no hay borrado físico de una cuenta con historial durable
  (membresías, ledger, pagos, reservas, ventas, material, reversales, operaciones y
  discrepancias de Stripe, notas, cliente de Stripe) ni con huella como staff; se usa
  la revocación. El borrado permitido deja `cuenta_eliminada` ANTES del DELETE, con
  actor y sin PII (sobrevive: `target_id` no tiene FK). Un reset de contraseña cuya
  evidencia falla sigue siendo un reset exitoso y se dice (`evidencia_registrada`).
  `writeAuditLog` queda para evidencia no crítica; ninguna mutación de cuenta depende
  de él. El rol legado `staff` deja de aceptarse en las funciones. **Refina EKKO-095 y
  EKKO-083; complementa EKKO-136 y EKKO-137.**

## PKG-06D — frontera de columnas y de cliente (2026-10-06)

- **EKKO-143 — PKG-06D · Seguridad de filas ≠ privacidad de columnas ≠ lo que
  pinta el cliente.** Todos los usuarios de la app comparten el rol de base
  `authenticated`: la RLS decide qué FILAS ve cada quien y no podía ocultar
  columnas; el miembro recibía `notas_admin`, `sancion_motivo`, los marcadores de
  06A y las `observaciones` del staff de sus reservas aunque la interfaz no las
  mostrara. (1) El privilegio SELECT de `authenticated`/`anon` sobre `usuarios` y
  `reservas` pasa a una lista explícita de columnas (migración B,
  `20261014110000`); `qr_token_hash` también queda del lado del servidor. Lo
  interno lo lee el staff por RPC SECURITY DEFINER con guardia de rol y tenant
  (`staff_datos_internos_cuenta`, `staff_observaciones_reserva`; migración A,
  `20261014100000`). Ninguna lectura del cliente usa `select('*')` sobre esas
  tablas (`columnas.ts`). Activación en dos pasos: A → deploy → B, para que el
  cliente publicado nunca expanda columnas revocadas. (2) La búsqueda del panel es
  `buscar_cuentas_staff(texto, rol, status)`: el texto es un parámetro ligado con
  `%`/`_`/`\` escapados; nunca se construye gramática `.or()` de PostgREST con
  texto del usuario. (3) Un error INTERNO (Postgres, PostgREST, Auth, Storage,
  Stripe, excepción) nunca viaja crudo al navegador: `errorInterno` deja la
  evidencia en el servidor y responde un texto fijo marcado `seguro`; el cliente
  (`backend.ts`) muestra el `error` de un 4xx (dominio/validación escrito a mano)
  y el de un 5xx solo si trae esa marca; los códigos EKKO_* y los parciales
  honestos de 06A se conservan. Las funciones programadas y el webhook (sin
  navegador) no cambian. (4) Content-Security-Policy en Netlify: `script-src`
  estricto ('self' + Stripe.js), `connect-src` Supabase + API de Stripe,
  `frame-ancestors 'none'`; `'unsafe-inline'` SOLO en `style-src` (librerías que
  fijan atributos style; React va por CSSOM), documentado en `netlify.toml` y
  fijado por `csp.test.ts`. Sentry no está en la política porque no está
  configurado (D-FIN-2). (5) Producción no publica source maps (`sourcemap:false`;
  con Sentry configurado: `hidden` + borrado tras subir) y `/*.map` responde 404.
  (6) E-16: `isLoading` dura hasta que la hidratación termina; un fallo deja
  `errorSesion` (Reintentar / Cerrar sesión) y una sesión válida sin perfil se dice
  (`sin_perfil`). La autorización sigue siendo del servidor. **Complementa a
  EKKO-020, EKKO-124, EKKO-136 y la serie E-01..E-06; no reabre 02C, F-1, R1,
  R2-B, 02H, 03A, 03B ni 06A.**
