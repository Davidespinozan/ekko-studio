# SALA → EKKO — Auditoría de paridad (2026-08-21)

> Qué tiene SALA (hermano en producción) que le falta a EKKO, qué bugs corrigió SALA
> que EKKO todavía arrastra, y qué NO aplica al modelo de EKKO. Solo análisis:
> **no se modificó código**. Cada fila cita archivo:líneas en ambos repos.

## 0. Contexto

- **EKKO no recibe commits desde el 2026-07-04.** SALA lleva **~320 commits** desde
  entonces (116 entre el 04 y el 25 de julio + 204 después). La divergencia real es
  de 7 semanas, no de 3.
- Ambos comparten kernel (Vite+React+TS, Supabase, Netlify Functions, Stripe Connect
  Express con direct charges, **la misma cuenta Stripe de la plataforma**).
- Modelo EKKO: renta de estudio por hora, **1 reserva por slot**, membresía mensual
  (Esencial/Premium) + paquetes de créditos, **todo cobro por Stripe**, sin efectivo,
  sin clases/cupo/lista de espera, sin huella, sin sucursales, sin tienda, single-tenant
  por `VITE_TENANT_SLUG`.
- Método: 7 análisis por dominio leyendo código real de los dos repos (`git show` de
  cada commit de SALA + `grep/cat` en EKKO). Los hallazgos P0 se re-verificaron a mano.
  Un supuesto P0 (`balance.retrieve({ stripeAccount })` "mostraría el balance de la
  plataforma") resultó **falso**: stripe-node trata ese objeto como options
  (`node_modules/stripe/cjs/utils.js` `getOptionsFromArgs`/`isOptionsHash`).

## 1. Corrección a la auditoría de Stripe Connect (misma sesión)

La recomendación "crear cuentas con `controller: { stripe_dashboard: express,
fees.payer: account, losses.payments: stripe }`" **ya la intentó SALA** el 17-jul:

| Commit SALA | Qué probó | Resultado |
|---|---|---|
| `b3a682c` | `controller` + dashboard `express` + `fees.payer='account'` + `losses='stripe'` | **500 en `accounts.create` en live** → revertido en `7d07842` |
| `5ac1441` | `type: 'standard'` | La cuenta se crea, pero **`accountLinks.create` falla (500)** → revertido en `436a0cd` |
| hoy | `type: 'express'` (idéntico a EKKO: `sala-studio/netlify/functions/connect-onboarding/index.ts:81-90`) | SALA paga los mismos Connect fees que EKKO |

Implicaciones:
1. El "500" es el `serverError` genérico del `catch` de la función; el mensaje real
   de Stripe no quedó registrado. Antes de descartar la combinación hay que
   reproducirla **en test mode logueando `err.raw`** (`err.type`, `err.code`,
   `err.message`).
2. Alternativa documentada por Stripe si Express-dashboard + `account` está vetado
   para esta plataforma: `stripe_dashboard: { type: 'none' }` + `fees.payer: 'account'`
   + `losses.payments: 'stripe'` + `requirement_collection: 'stripe'` (combinación
   soportada; Account Links funcionan; el dashboard se sustituye por
   **embedded components / Account Sessions**, y `createLoginLink` deja de aplicar).
3. Standard + Account Links sí está soportado por Stripe desde 2023; el fallo de SALA
   también merece ver el error real (puede ser configuración del perfil de
   plataforma, no una limitación de la API).
4. Sea cual sea la salida, el costo mensual actual es ~$2 USD + payout fees por
   cuenta activa; con 1–2 tenants es un problema de principio, no de caja. No vale
   migrar cuentas existentes hasta tener la combinación validada en test.

## 2. P0 — bugs que ya afectan producción (o rompen un flujo completo)

| # | Bug | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| P0-1 | **Los 3 crons nunca han corrido.** `[[scheduled_functions]]` no existe en Netlify; lo ignora en silencio. Afecta `cron-expirar-membresias` (expira paquetes, zera créditos, reconcilia subs huérfanas de Stripe), `cron-no-shows`, `cron-recordatorios`. | `netlify.toml:37-47`; los 3 `cron-*/index.ts` no exportan `config.schedule` | `9bb2b84` → `[functions."cron-x"] schedule = "…"` (SALA descubrió 53 membresías vencidas "activas") | S |
| P0-2 | **Recepción/admin no pueden asignar ningún plan actual.** `TIERS_PERMITIDOS = ['basica','pro']` pero los tiers reales son `starter/creador/pro-pack/sesion-suelta` + Esencial/Premium → "Plan no permitido" → no se puede "Activar membresía" en mostrador. | `netlify/functions/reception-update-member/index.ts:43,156-163`; seeds `20260703140000`, `20260704120000` | — (validar contra `tiers.activo` del tenant, como hace `reception-activar-membresia`) | S |
| P0-3 | **"Bloqueo por no llegar (días)" es una perilla muerta.** La versión vigente de `marcar_no_shows()` hardcodea umbral 3 / `interval '7 days'` y no lee `config.penalizaciones`; `reception-marcar-no-show` igual. La versión `20260517000001` sí lo leía; se perdió el 04-jul. | `supabase/migrations/20260704170000_audit_fixes_db.sql:233-290` (`:272`); `reception-marcar-no-show/index.ts:108-117`; UI `AjustesReglas.tsx:273-301` | `893e91d` / `20260714130000_no_show_bloqueo_opcional.sql` (0 = no bloquear + aviso al socio + self-test) | S |
| P0-4 | **La devolución de créditos usa el campo equivocado.** `creditos_devolver_al_cancelar` lee `anticipacion_min_horas` (24h) en vez de `cancelacion_min_horas_antes`. Si el admin pone cancelación = 2h, un miembro que cancela a 12h (permitido por el RPC) **pierde el crédito sin aviso**. | `20260702120000_costo_creditos_por_estudio.sql:112`; la ventana real en `20260704200000_cancelacion_ventana_miembro.sql:63` | `c3335c8` (texto de reglas) | S |
| P0-5 | **"Llegando ahora" muestra fantasmas.** El split clasifica solo por hora; canceladas/completadas/no_show en ventana salen resaltadas como "llegando". | `src/reception/components/ReservasHoyView.tsx:199-221` | `677c6d3` (`r.status === 'confirmada'`) | S |
| P0-6 | **MRR/ARR/ARPU/LTV inflados.** El cálculo suma **todas** las membresías activas, incluidos paquetes de créditos (`tipo` ni se selecciona); `mensualizar()` solo mira `periodo`. | `src/admin/hooks/useReportesEconomia.ts:33-37`; `src/admin/logic/reportesEconomia.ts:48-50` | `4ef2d4b` (excluir pago único/créditos, normalizar por `duracion_dias`) | S |
| P0-7 | **La ficha admin escribe `usuarios.membresia_tier` a mano** (B3 del BACKLOG sigue abierto): `handleSave` → `updateMiembro` sin pasar por `activar_membresia` ni leer `membresias` → plan/vigencia/créditos divergen entre admin, recepción y reportes. | `src/admin/pages/MiembroDetalle.tsx:46-59,147-170` | `18f00e7` / `bca45ce` (leer de `membresias`, derivar "vencida" por fecha) | M |
| P0-8 | **`tiers_permitidos` vacío = estudio inalcanzable, sin aviso.** Gate `= ANY()` rechaza todo con array vacío; el admin puede destildar todos los planes; archivar un tier deja slugs fantasma (sin FK/trigger); el front dice lo contrario (`reservaLogic.ts:174`). | `20260704190000_reserva_concurrencia.sql:~112`; `src/admin/pages/Recursos.tsx:721-728` | `4d694c3` / `20260715130000_acceso_por_plan_sin_trampas.sql:95-97` (vacío = abierto, trigger de slugs activos) | M |
| P0-9 | **Acceso: no existe recuperar ni cambiar contraseña.** Sin `/recuperar` ni `/nueva-contrasena`; `Login.tsx` sin link; el "email de recuperación" del admin redirige a `/login` sin página que consuma el token; el miembro no puede cambiar su clave en Perfil; las copys prometen lo contrario (`CredencialesCreadasModal.tsx:145-146`). | `src/public/PublicLayout.tsx:74-78`; `MiembroDetalle.tsx:533-570`; grep `password` en `src/member` = 0 | `5c08be8`, `15efa5b`, `CambiarPasswordGate.tsx` | S |
| P0-10 | **Escalada recepcionista → admin.** `reception-reset-password` no valida el `rol` del target: un recepcionista puede resetear (vía API) la clave de un admin. | `netlify/functions/reception-reset-password/index.ts:73-87` | `sala reception-reset-password/index.ts:72-79` | S |
| P0-11 | **Webhook de Connect sin filtro `metadata.app` y sin `account.updated`.** La cuenta Stripe es compartida con SALA/HSC: los eventos de gyms de SALA llegan al endpoint de EKKO → `activar_membresia` falla → 500 → reintentos + ruido en `stripe_webhook_events`. Y un estudio aprobado por Stripe sigue en `cobros_no_activos` hasta que alguien abre `/admin/cobros`. | `netlify/functions/_lib/stripe.ts:107-195` (sin `app`, sin `account.updated`); `connect-status` es el único refresco | `sala stripe-webhook/index.ts:119,169,188,214,255,285-298`; `2758c7e` | S |
| P0-12 | **`expirar_membresias_vencidas()` ejecutable por cualquier `authenticated`** (SECURITY DEFINER sin REVOKE): expira paquetes de **todos** los tenants y devuelve el conteo global. | `20260703120000_expirar_membresias.sql` + recreación `20260704170000:182-227`; `grep REVOKE.*expirar` = 0 | `20260709180000_fix_crons_revoke_authenticated.sql`, `20260804190000_revoke_definer_authenticated.sql:13-38` | S |

## 3. P1 — robustez, seguridad y funcionalidad que sí aplica

### 3.1 Infraestructura / plataforma
| Gap | EKKO | SALA | Esf. |
|---|---|---|---|
| Token vencido en PWA dormida: refresh proactivo (<120 s) + 1 reintento tras 401 | `src/shared/lib/backend.ts:6-10` manda el token tal cual | `backend.ts:6-22,29-68` (`ff09671`, `c5deb5e`) | S |
| PWA: auto-recarga al detectar SW nuevo, `vite:preloadError`, `lazyConRecarga`, `cleanupOutdatedCaches` | `main.tsx` sin listeners; `App.tsx:8-11` `lazy()` pelado | `main.tsx:18-62`, `autoReload.ts`, `lazyConRecarga.ts`, `vite.config.ts:60` (`058cc8b`, `85dab90`) | S |
| Sentry en Netlify Functions (`@sentry/node`), `conMonitorCron` (dead-man switch) y centinela de frescura | Solo `console.error`; `_lib/` sin `sentry.ts` | `_lib/sentry.ts` (`985ffbb`, `c069dd3`) | M |
| `setSentryUser` nunca se llama; sin filtro de ruido del SW | `sentry.ts:26-33` definido, 0 usos | `AuthProvider.tsx:49`, `sentry.ts:19-29` | S |
| Guardar Reglas/Marca tras carga fallida **borra config**: `useTenantConfigEditor` cae a `{}` y `saveTopLevel` escribe `{...{}, ...patch}` | `useTenantConfigEditor.ts:29-31`; `AjustesMarca.tsx:41-49` | `f4785c2` (bloquear Guardar + reintento) | S |
| Zona horaria: reportes/listas/recepción usan el reloj del navegador (solo 2 archivos usan `timezone.ts`) | `useAdminData.ts:455-458` (día UTC en gráfica 30 d), `ReservasVistaLista.tsx:39-76`, `useReservasHoy.ts:36-41`, `reservaLogic.ts:50-170`, `CrearReservaModal.tsx:132`, `VistaSemana.tsx:25-67`, `toLocaleTimeString` sin `timeZone` en ~8 archivos | `dac89fb`, `8c53dde`, `625701e`, `bfd0200`, `1310665` | M |
| Test que falle si `netlify.toml` vuelve a `[[scheduled_functions]]` o falta `schedule` por cron; confirmar `vars.RUN_E2E` (hoy el smoke e2e puede no correr nunca) | `ci.yml:48` | — | S |
| `maxNetworkRetries: 2` en el cliente Stripe | `_lib/stripe.ts:19-22` | `_lib/stripe.ts:12-13` | S |

### 3.2 Seguridad / base de datos
| Gap | EKKO | SALA | Esf. |
|---|---|---|---|
| Storage sin scope de tenant (estudios/logos/avatars: 9 policies solo exigen rol admin; `avatars_admin_*` además aceptan rol `staff` inexistente) — M3 del `SECURITY_AUDIT.md` sigue abierto | `20260517100000:32-71`, `20260517600000:102-127`, `20260514150000:24-47` | `20260613000500`, `20260804200000:13-92` (rutas idénticas: se porta sin tocar front) | S |
| `tenants`: columnas `stripe_*` legibles por `authenticated` y actualizables por admin (`tenants_admin_update` sin lista de columnas; `stripe_charges_enabled` es el gate de cobro) | `20260704180000:20-23` solo revoca a `anon`; `20260514100800:30-34` | `20260804140000:13-24` (REVOKE de tabla + GRANT por columnas a anon **y** authenticated) | S |
| Oráculos `count_active_admins/count_admins_activos(p_tenant_id)`, `count_reservas_recurso`, `count_miembros_tier` sin guard de tenant — L1 abierto | `20260514130000:19-32`, `20260517500000:14-25`, `20260517400000:9-39` | `20260819120000:47-93` (`COALESCE(get_my_tenant_id(), p_tenant_id)`) | S |
| Sin tests de privilegios/contrato (allowlist de DEFINER ejecutables por authenticated, `has_column_privilege` en tenants, `foldername`+`get_my_tenant_id` en storage) | `sec_fix_checks.sql:87`, `schema_drift_check.sql:253,262` solo existencia | 24 migraciones con self-test; `_fn_contiene` `20260819120000:523-584` | M |
| Menores: `DROP POLICY recursos_read_public/tiers_read_public` (L3), `WITH CHECK` en `notificaciones` (M4), `RAISE` en vez de fallback a `'ekko'` en `handle_new_auth_user`, mensaje genérico en `fake-signup.ts:112` | — | — | S |

### 3.3 Acceso / identidad
| Gap | EKKO | SALA | Esf. |
|---|---|---|---|
| Gate de cambio forzado de contraseña (clave dictada por staff no debe ser definitiva; la cuenta tiene tarjeta Stripe y créditos) | Ningún `must_change` en los 3 layouts | `CambiarPasswordGate.tsx:17-37` montado en `MemberLayout:87`, `AdminLayout:68`, `ReceptionLayout:96` (`34ff71d`, `1cd8f46`) | S–M |
| Hard delete de staff truena por FKs sin `ON DELETE` (`reservas.check_in_by`, `reservas.cancelada_por`, `notas_miembro.autor_id`, `audit_log.actor_usuario_id`) → "Database error deleting user" | `admin-delete-user/index.ts:105-134` | `0f89a8c` (pre-check + 409 humano) — o `SET NULL` por migración | S |
| "Resetear contraseña" del staff en `Equipo.tsx` (la función ya existe) y reutilizar el `ResetPasswordModal` de recepción en admin | `Equipo.tsx:404-407` | `Equipo.tsx:72,460` | S |
| Cumpleaños: card en Hoy/dashboard + felicitación push (el dato ya es obligatorio por la ficha de identidad; el canal push ya existe) | grep `cumple` = 0 | `CumpleanosCard.tsx`, `cron-felicitaciones`, `20260727220000` (`8442a85`, `b0ba8e4`) | S–M |

### 3.4 Recepción / reservas
| Gap | EKKO | SALA | Esf. |
|---|---|---|---|
| `reservar_para_miembro_atomic` nunca se re-creó: no valida `recursos.horarios`, ignora `permitir_continuas`, sin `FOR UPDATE`, no traduce `exclusion_violation`, sin tope diario, `max_invitados_por_tier()` hardcoded pro/basica (cae a 0 con tiers actuales) | `20260520100000_recepcion_plus_rp1.sql:47-180` | — | M |
| Recepción manda `p_invitados: 0`; **reprogramar pierde los invitados** | `CrearReservaModal.tsx:232`, `reprogramarReserva.ts:81` | `e2e6b43` | S |
| Corregir asistencia: marcar "sí asistió" a un `no_show` del cron (y revertir `no_shows_count`/`bloqueado_hasta`) | Solo existe la inversa (`reception-corregir-checkin`); `check_in_*` rechazan `no_show` | `5580fdb` / `20260815160000` | M |
| Vigencia y créditos restantes visibles en el check-in y en la ficha de recepción (hoy solo el chip del tier de `usuarios`) | `CheckInDetail.tsx:139-153`; `PerfilMiembroRecepcion.tsx:75-79` | `f4ea7ac`, `bca45ce` | S–M |
| Walk-in: reservar + check-in en un paso; slots ya iniciados reservables (el backend ya lo permite, el front los marca `pasado`) | `CrearReservaModal.tsx:221-239`; `reservaLogic.ts:108` | `f011a92` | S |
| No-show / cancelación tardía deben consumir el cupo del día (hoy liberan el día y se re-reserva gratis) | tope cuenta solo `confirmada/completada` (`20260704190000`) | `3a1f3aa` / `20260815200000` | M |
| Anticipación **máxima** solo vive en el front (la RPC la perdió); un mensual puede reservar a meses vista por RPC directo | `20260704190000:55-200` sin `EKKO_ANTICIPACION_EXCESIVA` (estaba en `20260514100900:93-112`) | `20260714140000:352-383` (trigger) | S |
| Check-in revalida membresía para **mensuales** (sin débito de créditos): cancelado/past_due entra a todas las sesiones que dejó reservadas | `check_in_*_atomic` no consultan `membresias` ni `usuarios.status` | `0c36273` / `20260717100000` | M |
| Cambiar plan no quema créditos sin avisar — servidor: `reception-activar-membresia` no mira `creditos_restantes` (la UI del socio sí avisa) | `reception-activar-membresia` grep `credito` = 0 | `03f0f74` (`p_confirmar_perdida`) | M |
| Aviso al miembro al marcarlo no-show / bloquearlo | `marcar_no_shows()` solo `audit_log` | `893e91d` | S |

### 3.5 Admin / planes / reportes / notificaciones
| Gap | EKKO | SALA | Esf. |
|---|---|---|---|
| `tiers.en_venta` separado de `activo` (dejar de vender un plan sin romper a sus miembros; hoy el archivado se bloquea si hay miembros) | `Tiers.tsx:115,165-166` | `6257844` / `20260806100000` | S |
| Columna "Membresía" (vigente/vencida·fecha/sin plan) + tooltips en `/admin/miembros` | `Miembros.tsx:134-176` muestra `membresia_tier` crudo | `6f3d977` | S |
| Historial de pagos por miembro en admin (`payment_events` ya se llena; solo lo ve el miembro) | `stripe-webhook:198-243`; `MiSuscripcion.tsx:494-503` | `a49c0a8` | S |
| Admin puede activar membresía manual (cortesía/transferencia) por el RPC keystone y mandar link de pago — hoy solo recepción | `PerfilMiembroRecepcion.tsx:118-160`; `NuevaPersonaModal.tsx:45,112` | `GestionarMembresiaModal.tsx` | M |
| Export CSV (miembros, pagos) | grep `csv` = 0 | `exportarCsv.ts` (+tests) (`f07ffdd`) | S |
| Aviso "plan por vencer" adaptado: paquetes `hibrido` con `periodo_actual_fin`, `cancel_at_period_end`, tarjeta por expirar | grep `vencer` solo en SQL | `cron-membresias-por-vencer` / `20260714120000:122-157` | S |
| Campana y avisos para admin/recepción (cobro rechazado, cancelación tardía, socio nuevo); `NotificacionesBell` solo en member | `MemberLayout.tsx`; webhook sin `notificaciones` | `NotificacionesBell` (3 roles), `AjustesNotificaciones.tsx` | M |
| `cron-push` central que despache `notificaciones` pendientes (hoy push cableado por disparador: cancelación por RPC y por admin no llegan al teléfono) | `_lib/push.ts` llamado en 3 sitios | `cron-push` / `push_y_avisos_criticos.sql` | S |
| Reportes: bloque "Cobrado real" + cobros fallidos (ya en `payment_events.status='failed'`) | `Reportes.tsx:59-63` | `useReportesCobrado.ts:61-95` | S |
| Dashboard "Ver detalle" de reserva es un stub (el modal existe) | `AdminDashboard.tsx:228` | — | S |
| Admin cancela reserva con `UPDATE` directo (se salta `cancelar_reserva_atomic`: sin guard de status, sin `audit_log`, sin push) | `crudHelpers.ts:280-340` | `bc0c7ec` | S |
| `charge.refunded` / `charge.dispute.created` no se manejan (un reembolso desde el dashboard Express no revierte créditos/membresía ni se refleja en `payment_events`) — **tampoco en SALA** | `stripe-webhook` grep = 0 | — | M |
| Pausar/congelar membresía con `pause_collection` + rollback (viajes/lesiones; hoy un "congelado" a mano sigue pagando) | grep `pausar|pause_collection` = 0 | `pausar-membresia/index.ts` | M |
| `EKKO_FEE_PERCENT` solo se aplica en el Checkout (fallback); los flujos Elements (`crear-pago-intent`, `cambiar-plan-suscripcion`, `crear-pago-invitados`) no cobran fee | `crear-pago-intent:174` "reservado" | `comprar-producto:252` | S |
| `scripts/stripe-setup-webhooks.mjs` (endpoint Connect, eventos = cases del código, chequeo anti-redirect 3xx/404) + `stripe-check.mjs`; `STRIPE.md` desactualizado (habla de `tiers.stripe_price_id` y cuenta del cliente; no menciona Connect, `STRIPE_CONNECT_WEBHOOK_SECRET`, "Connected accounts", ni el **host**: `ekkostudio.app` responde 400 directo, `www.` redirige 308 → si alguien registra el webhook con `www` se pierden todos los eventos en silencio, como le pasó a SALA en `3fddde9`) | `STRIPE.md:47-68` | `a3ca993`, `4fa11ff`, `STRIPE_SETUP.md` | S |

## 4. P2 — deseable

- Anticipación mínima en minutos (`43ceed5`); tope diario por plan (`a873afd`); `visible_landing` (`a90f7b6`); "pase de 1 día por tiempo".
- Paginación en `BuscarMiembro` (hoy `limit(1000)` + `slice(0,100)`); pestañas por estado en "Resto del día"; nombres de invitados en check-in/ficha; vista admin de prospectos (invitados); badge "Cuenta activa" ≠ plan.
- Gráfica 30 días en Recharts con ejes; "?" en KPIs del dashboard; `InfoTooltip align='right'`; selector de período en Reportes; export PDF con marca; bitácora global filtrable; `LandingPreview`; contador "N clientes · M vigentes".
- Recibos: guardar `charge.receipt_url` / `invoice.hosted_invoice_url` en `payment_events` y exponer "Ver/Reenviar recibo" (evita portar el motor de recibos de SALA).
- `ErrorBoundary` con variante inline + `resetKeys` por ruta; `scripts/devFunctionsPlugin.ts` (functions dentro de `vite dev`); `E2E.md`.
- Columna `sexo` y edad calculada; "FOTO PRÓXIMAMENTE" → "SIN FOTO" (`EstudioDetalle.tsx:128`, `Estudios.tsx:94`, `EstudioModal.tsx:132`); estado vacío/error en `Estudios.tsx`; 15 strings con voseo residual (`_lib/email.ts`, `PaymentModal.tsx`, mensajes de functions).
- CHECKs de `tiers.moneda`/`duracion_dias`; radar de columnas en la whitelist de `tenants`; loguear (no descartar) el error del `select` con token de usuario en 12 functions; `carnetMembresia.ts:119` "Contacta a EKKO" → `tenant.nombre`; fallback `'pro'/'basica'` de invitados en RPC y `Tiers.tsx:551`; `Signup.tsx:234` ignora `tiers.moneda`.
- Módulos/feature flags por tenant (`config.modulos` + `useModulo`) y **facturación SaaS completa** (plataforma → estudio: `suscripciones_saas`, `suscribir-saas`, `stripe-webhook-saas`, `portal-saas`, `accesoSaas` con gracias, paywall en `AdminLayout`, límites por plan, cupón fundador). Hoy EKKO no le cobra nada a sus estudios; es **L** y pasa a P0 el día que exista el estudio #2 pagando. Port casi directo con prefijo `ekko_` y `app:'ekko'`.

## 5. NO aplica a EKKO (descartado a propósito)

Tienda/POS/kardex · corte de caja · cuentas por cobrar · método de pago en mostrador · multas cobradas en caja (si se quisieran, irían por Stripe como `crear-pago-invitados`) · huella/agente Windows/lectores · sucursales/sedes · instructores · mapa de salón/lugares · cupo/lista de espera/spotlight · agenda agrupada por clase · pases de invitado por periodo · day pass por día no cubierto · planes por día de la semana y ventanas fijas de preventa · socios "sin correo" · importar CSV/claim de cuenta (no hay base legada) · ficha-sin-login + `/activar` abierto por email y clave fija pública `Cambiar123` (inaceptables con tarjeta Stripe guardada; EKKO debe mantener clave aleatoria + gate de cambio) · onboarding wizard de tenants y redirección por subdominio (EKKO es single-tenant por env) · edge function `tenant-meta` (OG estáticos ya correctos) · `cerrar_tenant()`.

## 6. Estado de ejecución (2026-08-21, rama `sprint-0-hotfixes`)

**Hecho:** los 12 P0 (§2) · Sprint 1 completo (acceso, ficha admin,
`tiers_permitidos`, storage/tenants/count_* + `hardening_checks.sql`) · Sprint 2
(backend 401/refresh, PWA, Sentry en functions + monitor + centinela,
`setSentryUser`, guard de config, zona horaria salvo calendario, scripts de
Stripe, `maxNetworkRetries`) · Sprint 3 parcial (RPC de recepción endurecida,
invitados, walk-in en un paso, vigencia visible, anticipación máxima en DB,
corregir asistencia) · Sprint 4 parcial (`en_venta`, columna Membresía, historial
de cobros, CSV, avisos por vencer, cumpleaños, campana staff, reembolsos, fee en
Elements). Migraciones nuevas: `20260821100000` … `20260821180000` (9).

**Pendiente (P1):** check-in que revalida mensuales vencidas/canceladas ·
no-show/cancelación tardía consumen el cupo del día · pausar membresía
(`pause_collection`) · `cron-push` central (hoy push por disparador) · reportes
"cobrado real"/fallidos · `VistaSemana`/`VistaDia` en zona del estudio · E2E.md
+ `RUN_E2E` · decisión de facturación SaaS y del `controller` de Connect.

## 6b. Plan sugerido (original)

**Sprint 0 — hotfixes (1–2 días, todos S salvo dos M):** P0-1 toml + correr los crons a mano para limpiar el backlog · P0-2 validar tier contra `tiers` · P0-3 leer `no_show_bloqueo_dias` (0 = no bloquear) · P0-4 campo correcto en `creditos_devolver_al_cancelar` · P0-5 filtro `confirmada` · P0-6 excluir créditos del MRR · P0-10 guard de rol en reset · P0-11 filtro `app` + `account.updated` · P0-12 REVOKE. Con tests (`netlify.toml`, mappers, RPCs).

**Sprint 1 — acceso y seguridad:** P0-9 recuperar/cambiar contraseña + gate forzado · P0-7 ficha admin por `membresias` + RPC keystone · P0-8 `tiers_permitidos` (vacío = abierto + trigger) · storage por tenant · `tenants` por columnas · oráculos `count_*` · tests de privilegios.

**Sprint 2 — plataforma:** backend.ts (refresh + 401) · PWA auto-update · Sentry en functions + `conMonitorCron` + centinela · `setSentryUser` · guard de carga en config editor · zona horaria en recepción/reportes · scripts de Stripe + `STRIPE.md`.

**Sprint 3 — recepción y membresías:** `reservar_para_miembro_atomic` re-creado · invitados en reservar/reprogramar · corregir asistencia · vigencia/créditos en check-in y ficha · walk-in 1 paso · anticipación máxima en DB · check-in revalida mensuales · aviso de no-show · pausar membresía.

**Sprint 4 — admin:** `en_venta` · columna Membresía · historial de pagos · activar manual desde admin · CSV · avisos por vencer + campana admin + `cron-push` · cobrado real/fallidos · refunds en webhook · fee en Elements · cumpleaños.

**Decisión aparte:** facturación SaaS (plataforma → estudios) y la combinación de `controller` para Connect (validar en test mode con el error real de Stripe).
