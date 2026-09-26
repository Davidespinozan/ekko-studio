# SALA → EKKO — Auditoría de paridad #2 (2026-09-20)

> Continuación de `SALA_PARITY_AUDIT.md` (2026-08-21). Las §0–§6 son el análisis, hecho
> sobre EKKO en `sprint-0-hotfixes` @ `e770efc` y SALA en `c67216e` (2026-09-14), y las
> citas `archivo:línea` se refieren a ese estado. **El Sprint A ya se ejecutó: ver §7.**
> Rutas relativas a `ekko-studio/` salvo las marcadas `S:` (= `sala-studio/`).
> **✔** = re-verificado a mano leyendo el código después del análisis por dominio.
> Sin ✔ = verificado por el análisis de dominio con `archivo:línea`, no re-leído.

## 0. Qué cambió desde la auditoría #1 y cómo se hizo esta

- La #1 listó los gaps y se "ejecutó" el mismo día en 32 commits. Esta #2 responde tres
  preguntas distintas: **(a)** ¿lo marcado "hecho" está hecho y en producción?,
  **(b)** ¿qué agregó SALA después (21 commits) y qué se le escapó a la #1?,
  **(c)** comparando por concepto pantalla por pantalla y RPC por RPC, ¿qué hace SALA
  que EKKO no, y qué bugs tiene EKKO que SALA evita?
- Método: 7 análisis por dominio (commits nuevos de SALA · verificación de §6 de la #1 ·
  miembro/público · recepción · admin · backend/Stripe · base de datos), cada uno leyendo
  código real en ambos repos. Los hallazgos P0/P1 principales se re-leyeron a mano.
- Conclusión de fondo: los ports de la #1 están bien hechos en su mayoría, pero
  **varios bugs graves de hoy nacieron en esas mismas migraciones** (funciones recreadas
  desde un cuerpo viejo, "tests de contrato" que solo hacen `position(texto in prosrc)`).
  SALA evita esa clase de error con self-tests **conductuales** dentro de cada migración
  (57 migraciones) y scripts `test_*.sql`. Ese es el gap estructural más importante.

## 1. Estado operativo — nada de la auditoría #1 está en producción ✔

| Hecho | Evidencia |
|---|---|
| La rama `sprint-0-hotfixes` (32 commits, 153 archivos, +8564/−432) **no está mergeada ni pusheada** | `git branch -a`: solo `main`, `sprint-0-hotfixes`, `origin/main`; `main` = `origin/main` = `014716e` (2026-07-04) |
| Producción sigue con `[[scheduled_functions]]` → **los crons siguen sin correr** (expirar membresías, no-shows, recordatorios) | `git show main:netlify.toml` líneas 40/44/48 |
| Las 12 migraciones `20260821*` **no están aplicadas** en el Supabase enlazado (probe de solo lectura: `tiers.en_venta`, `notificaciones.push_enviado_at`, `membresias.pausada_at` → 42703; RPC `cumpleanos_proximos` → PGRST202). Dato del análisis, no re-probado a mano | `supabase migration list --linked` solo llega a `20260517600000` |
| **Orden de deploy obligatorio**: `Landing.tsx:82` y `Signup.tsx:44` filtran `.eq('en_venta', true)`; si el front sale antes que `20260821180000`, landing y signup truenan | — |
| En la rama: `tsc` OK · `lint` OK · `vitest` 87 archivos / 569 tests OK | corrido 2026-09-20 |
| CI solo corre en push/PR a `main` → **nunca corrió sobre esta rama**; job e2e apagado (`vars.RUN_E2E`) y el smoke es un placeholder de 8 líneas | `.github/workflows/ci.yml:48`, `e2e/tests/smoke-landing.spec.ts` |
| Faltan env en Netlify: `STRIPE_CONNECT_WEBHOOK_SECRET`, `VAPID_*`, `RESEND_API_KEY`, `SENTRY_DSN`, `EKKO_*`; `.env.example` no las documenta | `.env.example` (12 variables) |

**Secuencia sugerida:** arreglar los P0 de §2 en la rama → aplicar las 12 migraciones (+ las
nuevas) → correr `supabase/tests/hardening_checks.sql` → PR a `main` (corre CI) → deploy →
verificar "Scheduled" en Netlify → correr los crons a mano para limpiar el backlog →
re-ejecutar `scripts/stripe-setup-webhooks.mjs`.

## 2. P0 — arreglar antes de subir la rama

| # | Bug | Evidencia EKKO | Cómo lo evita SALA | Esf. |
|---|---|---|---|---|
| P0-1 ✔ | **Quien paga un cambio de plan queda `cancelado`.** El webhook cancela la sub anterior tras activar la nueva → Stripe emite `customer.subscription.deleted` de la sub vieja → `sync_membresia_stripe` pone `usuarios.status='cancelado', membresia_activa_id=NULL` sin mirar si esa membresía es la vigente ni si ya estaba cancelada. En mensual se autocura en el siguiente `invoice.paid`; **en paquete nunca**. Pasa igual cuando recepción activa un plan manual sobre una mensualidad. Además la migración de pausa recreó la función desde un cuerpo viejo y **perdió `membresia_tier = NULL`** (fix de `20260704230000_cancelado_recompra.sql:73`) | `supabase/migrations/20260821200000_pausar_membresia.sql:118-120,165-167`; `netlify/functions/stripe-webhook/index.ts:37-66,155-165`; camino desde UI `src/member/components/MiSuscripcion.tsx:204-209` | 1 fila por socio (upsert) `S:20260717110000:97-151`; el webhook nunca toca `usuarios` (`S:stripe-webhook/index.ts:167-176`); guard `tiene_mensualidad` (`d253e6d`) | S |
| P0-2 ✔ | **Admin demo con contraseña fija en git.** `admin-seed-demo` crea `demo-admin@ekkostudio.app` con rol admin/activo y `DEMO_PASSWORD = 'DemoEkko2026'` en el tenant de producción, sin guard de entorno; cada corrida la resetea al mismo valor. La #1 (§5) calificó de inaceptable una clave fija pública | `netlify/functions/admin-seed-demo/index.ts:24,33-37,112-128`; botón en `src/admin/pages/Equipo.tsx:280` | No existe; el demo de SALA es un tenant aislado | S |
| P0-3 ✔ | **Escalada recepcionista → admin por cambio de email.** `reception-update-member` carga al target sin leer `rol`; cambia el email de login con `email_confirm:true` → `/recuperar` entrega la cuenta admin (Stripe Connect, reembolsos, PII). P0-10 de la #1 cerró esto solo en reset-password. Revisar la misma clase en `reception-datos-identidad`, `reception-notificar-miembro`, `reception-activar-membresia` | `netlify/functions/reception-update-member/index.ts:103-110,257-262`; `src/reception/pages/PerfilMiembroRecepcion.tsx:82-86` abre cualquier `usuarios.id` | El contacto de recepción no toca el login (`S:EditarContactoModal.tsx:19-20,70`); `ROL_INVALIDO` en los RPC | S |
| P0-4 ✔ | **"Revocar acceso" no revoca nada.** Solo escribe `status='revocado'`: `useAdminGuard` y `ReceptionLayout` miran solo `rol`; `get_my_rol()/is_admin()/is_recepcionista()` ignoran `status` (RLS sigue concediendo todo); ~17 functions de staff validan rol pero no status. H2 del `SECURITY_AUDIT.md` quedó "verificado", no corregido | `src/admin/hooks/useAdminGuard.ts:30-37`; `src/reception/ReceptionLayout.tsx:36-46`; `supabase/migrations/20260514100700_helper_functions.sql:32-70`; `src/admin/lib/crudHelpers.ts:247-256`; functions: solo `connect-onboarding:56` y `connect-status:45` validan status | `S:useAdminGuard.ts:39-59` (`accesoRevocado`), `S:20260613002500:31-58` (`AND status='activo'` + tests), `fc6fd7a` en functions | S |
| P0-5 ✔ | **Reserva gratis sin membresía viva (latente).** Ninguna RPC de reserva consulta `membresias`: solo `usuarios.status='activo'` + `_recurso_permite_tier`, que con lista vacía devuelve true aunque el tier sea NULL (y `'{}'` es el DEFAULT desde el fix P0-8 de la #1). El trigger de débito hace `RETURN NEW` sin membresía. El cron de expiración deja `status='activo'`. Hoy no se dispara porque los estudios sembrados tienen lista poblada; se dispara con cualquier estudio nuevo o "abierto a todos". El QR lo frena en la puerta; el manual solo avisa (y ver P0-6) | `20260821190000_checkin_membresia_y_cupo.sql` (RPC, guards en :48-67 del cuerpo); `20260821130000_tiers_permitidos_sin_trampas.sql:29-37,54`; `20260702120000_costo_creditos_por_estudio.sql:45-47`; `20260704170000_audit_fixes_db.sql:204-221`; front `src/member/logic/reservaLogic.ts:194` | Gate `SIN_MEMBRESIA/CONGELADA/VENCIDA` con `FOR UPDATE` dentro del RPC (`S:20260815220000:135-170`) + `scripts/test_membresias_gate.sql` (11 casos) | M |
| P0-6 ✔ | **El aviso de membresía del check-in manual nunca se muestra.** El RPC devuelve `membresia_estado` para avisar, pero `Hoy.tsx` monta `<ReservasHoyView />` sin `onManualCheckInSuccess` → `CheckInDetail` (única pantalla que pinta el aviso) solo abre por QR, donde siempre es `ok`. El walk-in también descarta el retorno, y tampoco se llega a `InvitadosModal`. El "QR bloquea, manual avisa" del Sprint 5 quedó a medias | `src/reception/pages/Hoy.tsx:13`; `src/reception/components/ReservasHoyView.tsx:514-522`; `CrearReservaModal.tsx:277` | `S:src/reception/pages/Scanner.tsx:93-112,175-190` | S |

## 3. P1

### 3.1 Dinero, Stripe y membresías

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| M1 ✔ | **`charge.refunded` tiene handler pero no está suscrito**; el script "sincroniza" la lista, así que lo quitaría si alguien lo agrega a mano. Los reembolsos (que la #1 da por hechos) nunca llegan. Falta test de paridad eventos ↔ `case` | `scripts/stripe-setup-webhooks.mjs:41-49`; `scripts/stripe-check.mjs:24-32`; `STRIPE.md:69-72`; handler `_lib/stripe.ts:241-254` | `S:scripts/stripe-setup-webhooks.mjs:55-66` | S |
| M2 ✔ | **Doble acreditación de paquetes por Checkout.** Sesión y PaymentIntent llevan el mismo `metadata`; ambos eventos clasifican `activar`; `activar_membresia` solo es idempotente con `subscription_id`. La UI no llama este endpoint (`iniciarCheckout` sin callers) pero está vivo: llamada directa = paga 1, recibe 2N créditos | `netlify/functions/suscribir-membresia/index.ts:104-116`; `_lib/stripe.ts:148-164,218-239`; `20260704170000_audit_fixes_db.sql:61-71` | `p_referencia` + índice único + `ON CONFLICT DO NOTHING` (`S:20260713100000:95`, `S:20260717110000:168-178`) | S–M |
| M3 ✔ | **Recomprar un paquete acorta la vigencia de los créditos arrastrados** (`v_fin := now + duracion` sin `GREATEST`, mientras los créditos sí se suman). Pro-pack con 10 créditos/100 días + "sesión suelta" → 11 créditos que vencen en 30 días. Igual para mensual manual: renovar el día 27 pierde 3 días | `20260704170000_audit_fixes_db.sql:87-98,101`; `reception-activar-membresia/index.ts:94-97` | apila: `S:20260819210000:131-137` (`f79162a`) | S |
| M4 | **Pausa incompleta.** (a) Reanudar no extiende `periodo_actual_fin` → paquete pausado 3 semanas vuelve vencido y el cron quema los créditos. (b) `'pausada'` quedó fuera del índice `membresias_one_active_per_user`, del cierre y saldo previo de `activar_membresia`, de la devolución de créditos, de `stripe-cancelar-suscripcion:65` y de `stripe-webhook:46` → membresías duplicadas, 23505 crudo al reanudar, pausado que no puede cancelar. (c) Doble push al pausar (RPC inserta sin `push_enviado_at` + push inline) | `20260821200000_pausar_membresia.sql:64-82`; `20260514100400:160-162`; `20260821110000:62`; `stripe-pausar-membresia/index.ts:121-128` | `S:20260613000700` (suma días pausados), `S:20260613002800`, lookups con `'congelada'` | M |
| M5 | **`sync_membresia_stripe('activa')` revive cuentas suspendidas/revocadas**: `UPDATE usuarios SET status='activo' WHERE status <> 'activo'` sin distinguir; un `invoice.paid` des-suspende a un sancionado | `20260821200000:159-161` | `usuario_status_historial` (`S:20260520160000:70`) | S |
| M6 | **Borrar un miembro con suscripción viva deja a Stripe cobrando** (pre-check solo mira reservas; `membresias` hace CASCADE; el reconciliador busca filas que ya no existen). Y borrar staff sigue tronando por FKs sin `ON DELETE` (pendiente de la #1) | `netlify/functions/admin-delete-user/index.ts:104-134`; FKs `20260514100500:30`, `20260517600000:17`, `20260611200000:17`, `20260611100000:18` | 409 por reservas **y** pagos (`S:admin-delete-user/index.ts:115-140`, `0f89a8c`) | S |
| M7 | **`idempotencyKey` de `prices.create` sin precio/nombre/moneda** → tras editar un plan, Stripe responde 400 hasta 24 h y nadie puede suscribirse a ese plan | `crear-pago-intent/index.ts:149-157`; `cambiar-plan-suscripcion/index.ts:107-115` | sin key (`S:suscribir-membresia/index.ts:206-214`) | S |
| M8 | **Webhook traga fallos**: no revisa `success:false` del RPC (`membresia_no_encontrada` pasa en silencio, síntoma de P0-1/M6); idempotencia "insertar primero" + `fetch` a Resend sin timeout + push en serie → si la function muere por timeout, el reintento responde `duplicate` y el evento se pierde. Sin script de reconciliación Stripe↔DB | `stripe-webhook/index.ts:122-132,201-208,348-350`; `_lib/email.ts:37`; `_lib/avisosStaff.ts:38-45` | `S:scripts/_audit_membresias_activas.mjs` | M |
| M9 | **Pago fallido: el miembro solo recibe email** (no-op sin Resend); sin notificación in-app ni push; `avisarStaff` anidado en `if (email)` | `stripe-webhook/index.ts:307-341` | `S:stripe-webhook/index.ts:228-243` | S |
| M10 | **La compra de paquete no manda ningún correo** (el email solo sale en `invoice.paid`; grep `receipt_email` = 0): ni confirmación, ni recibo, ni fecha de vencimiento | `stripe-webhook/index.ts:335-337`; `_lib/email.ts:117-152` | `1fb4ade` | S |
| M11 | **`en_venta` no se valida en servidor** (las 3 functions de cobro solo miran `activo`) → un plan retirado se compra por API. SALA tampoco | `crear-pago-intent:70`, `suscribir-membresia:71`, `cambiar-plan-suscripcion` | — | S |
| M12 | **Pérdida de créditos al cambiar plan sin confirmación del servidor** (pendiente de la #1, §3.4); activación de mostrador sin `motivo` obligatorio, sin rastro de pago y sin cuidar una sub Stripe viva (la marca cancelada en DB y Stripe sigue cobrando); copy "cobro en caja" en un modelo sin caja; `reception-create-member` no valida el tier | `reception-activar-membresia/index.ts:28-31,70-107`; `RegistrarMiembroModal.tsx:47-51`; `EstadoCuentaCard.tsx:37-40`; `reception-create-member/index.ts:113-120` | `p_confirmar_perdida` + `MOTIVO_REQUERIDO` (`S:20260716110000:36,166,304`, `S:CambiarPlanModal.tsx:96-108`) | M |
| M13 | **No existe RPC auditado para ajustar créditos** (cortesía, falla del estudio, reverso por reembolso): la única vía es `UPDATE` directo por `membresias_admin_all`, que descuadra el ledger | grep `recargar_creditos\|ajustar_creditos` = 0 | `recepcion_recargar_creditos` (`S:20260612030000:13`), `RecargarCreditosModal.tsx` | S–M |
| M14 | **El staff no puede cancelar la membresía/suscripción de un miembro** (las functions solo aceptan el JWT del miembro). En un modelo mes a mes es petición típica de mostrador | `stripe-cancelar-suscripcion/index.ts:16`; grep en `src/admin`/`src/reception` = 0 | `S:CancelarMembresiaModal.tsx:16-22` | M |
| M15 | **Cancelación tardía: regla inalcanzable.** El RPC prohíbe al socio cancelar dentro de la ventana, así que "cancela tarde → pierde crédito y cuenta en el tope" (Sprint 5) nunca ocurre; si cancela recepción es `cancelada_admin` → siempre devuelve y no cuenta | `20260704200000_cancelacion_ventana_miembro.sql:67-70`; `20260821110000:52-55`; `20260821190000:496-497` | `S:20260713110000:~480-487` | S |
| M16 | **Cancelar una reserva con invitados extra ya pagados no avisa ni reembolsa** (específico de EKKO; riesgo de contracargo); `Terminos.tsx` no lo cubre | `CancelarMiReservaModal.tsx:239-268`; grep `refund` en `src/member` = 0 | n/a | S aviso / M reembolso |

### 3.2 Seguridad e integridad

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| S1 ✔ | **`p_duracion_min` llega del cliente sin validar y el costo es fijo por reserva**: `p_duracion_min: 720` bloquea el estudio todo el día por 1 crédito; con cruce de medianoche el chequeo de horario (`::time`) pasa. Bug nativo de EKKO | `20260821190000` RPC `reservar_recurso_atomic` (solo calcula `slot_fin`); `20260821170000:31,127` | n/a (clases de duración fija) | S |
| S2 | **Sin backstop "último admin" en DB** (solo un oráculo consumido por el front); `admin-update-role` deja que un admin se degrade a sí mismo | grep `ultimo_admin` = 0; `admin-update-role/index.ts:75-88` | `trg_proteger_usuarios` (`S:20260613002500:67-105`) | S |
| S3 | **`_estado_membresia_checkin`** (DEFINER, nueva del Sprint 5) concedida a `authenticated` sin guard de tenant/rol: cualquier socio consulta por UUID si otro está vencido/suspendido | `20260821190000:22-61` | REVOKE (`S:20260804190000:26`) | S |
| S4 | `proteger_columnas_privilegiadas_usuarios` no cubre `membresia_activa_id`, `notas_admin`, `email`; `usuarios_update_self` permite UPDATE de toda la fila → el socio edita las `notas_admin` que se muestran en el check-in | `20260620170000:41-62`; `20260514100800:60` | grants por columna (`S:20260709150000/160000`) | S |
| S5 | Ledgers "append-only" solo por RLS; `membresia_movimientos` hace CASCADE al borrar al socio → desaparece su ledger | `20260620150000:44-46` | triggers `no_update/no_delete` (`S:20260716100000:181-205`, `S:20260819200000:23`) | S |
| S6 | Errores crudos de Stripe/Postgres al cliente (7 functions); `fake-signup` público sin rate-limit y con mensaje crudo de auth; sin CSP en `netlify.toml` (igual que SALA) | `suscribir-membresia:164`, `crear-pago-intent:182`, `fake-signup.ts:113` | mensajes genéricos en SALA | S–M |
| S7 | Mensajes generados en DB con `to_char` sin zona → **"Tu reserva del 21/08 23:00 fue cancelada"** cuando era a las 16:00 locales; "El check-in abre a las 22:45" (SALA arrastra parte de esto) | `20260704200000:84`; `20260821190000:139,144,269,274,386` | `AT TIME ZONE v_tz` (`S:20260815220000:~165`) | S |
| S8 | Folio por `count(*)+1` sin UNIQUE (la secuencia `reservas_folio_seq` existe y no se usa) → folios duplicados en reservas simultáneas + seq-scan por reserva | `20260821190000:519-520`; `20260514100500:54,63` | — | S |
| S9 | Menores de la #1 que siguen abiertos: DROP de `recursos_read_public`/`tiers_read_public`, `WITH CHECK` en `notificaciones`, fallback a `'ekko'` en `handle_new_auth_user`, CHECKs de `tiers` (precio, `clases_incluidas`, `duracion_dias > 0`, `creditos_restantes >= 0`) | `20260514100800:94,118`; `20260514101000:24-34` | `S:20260613002800:22-27`, `S:20260717120000:22-27` | S |

### 3.3 Recepción

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| R0 | **Causa raíz**: la ficha de recepción decide sus acciones por `usuarios.status`; SALA las decide por el **estado de la membresía** y refresca toda la ficha tras cada acción. De ahí salen R1–R3 | `src/reception/components/perfil/EstadoCuentaCard.tsx:26,35-55` | `S:src/reception/pages/SocioFicha.tsx:185,403-424` | — |
| R1 | **Miembro en pausa ve "Activar membresía"** en vez de "Reanudar" → crea otra membresía activa y deja la pausada viva con su sub en pausa | `EstadoCuentaCard.tsx:35-55`; `20260821200000:64` | `SocioFicha.tsx:403-424` | S |
| R2 | **No hay flujo para renovar a un miembro `activo` sin plan vigente** (el caso más común: "se me acabó el paquete"): `EstadoCuentaCard` devuelve `null`. Salida actual: bajar la cuenta a `pendiente_pago` a mano | `EstadoCuentaCard.tsx:26,35`; `20260704170000:205-222` | `RenovarMembresiaModal`, `AsignarPlanModal` | M |
| R3 | **Ficha desactualizada tras activar/pausar**: `VigenciaMembresia` tiene su propia instancia de `useMembresiaVigente` que solo carga al montar → recepción cree que falló y repite | `PerfilMiembroRecepcion.tsx:54,154-167`; `VigenciaMembresia.tsx:17-18` | un solo `refetch` | S |
| R4 | **Un slot en curso de un ausente no se puede liberar**: no-show exige `slot_fin < now`, cancelar exige `slot_inicio > now` → una hora de estudio perdida por cada ausente (cuesta más en 1-reserva-por-slot que en clases) | `reception-marcar-no-show/index.ts:96-98`; `20260704200000:54` | no-show en cualquier momento sobre `confirmada` (`S:20260613002900`) | S |
| R5 | `reservar_para_miembro_atomic` sin membresía vigente ni `rol='miembro'`; `EditarMiembroModal` deja poner `status='activo'` y plan a mano (reaparece P0-7 de la #1 en recepción) | `20260821170000:83-107`; `EditarMiembroModal.tsx:31-36,78-85` | `S:20260715130000` (`ROL_INVALIDO`, `SIN_MEMBRESIA`) | M |
| R6 | Cancelación por recepción sin `audit_log` y con motivo opcional; no-show manual no atómico (lee y escribe desde Node sin `.eq('status','confirmada')`); `reception-marcar-asistio` devuelve 500 crudo si el slot ya fue re-reservado | `CancelarReservaRecepcionModal.tsx:51-54`; `reception-marcar-no-show/index.ts:131-141`; `reception-marcar-asistio/index.ts:107` | `_audrec_log('reserva.cancelar')`; RPC único | S |
| R7 | Faltan: cancelar/no-show desde la tarjeta de Hoy, check-in de un toque en "Llegando ahora", bloqueo manual con fecha y motivo (hoy solo `suspendido`, que tumba el login), búsqueda por teléfono, foto en Hoy y padrón, aviso previo de ficha de identidad/contrato pendiente en las tarjetas | `ReservasHoyView.tsx:449-452,512-527`; `BuscarMiembro.tsx:71,108`; `useReservasHoy.ts:45` | `S:ReservasHoyView.tsx:176-187,363-391,495-505`; `BloquearSocioModal.tsx` | S c/u |

### 3.4 App del miembro y parte pública

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| A1 ✔ | **Solo se puede cancelar la PRÓXIMA reserva**: `BotonCancelarReserva` tiene un único uso; las filas de Mis reservas solo enlazan al QR y `MiQR` no tiene cancelar → la 2ª reserva termina en no-show | `src/member/components/ProximaSesionHero.tsx:64`; `MisReservas.tsx:165-197` | `S:Reservar.tsx:266-283` + `ConfirmarCancelacionModal` | S |
| A2 ✔ | **Plan retirado de venta = "Sin plan" y sin botón de cancelar** (el caso de uso exacto de `en_venta`): el suscriptor sigue pagando sin poder darse de baja | `MiSuscripcion.tsx:93-97,173,327-332,408` | plan actual por JOIN de la membresía (`S:useMembresiaActual.ts:107-110`) | S |
| A3 ✔ | **El QR desaparece en cuanto empieza la sesión** (`gte('slot_inicio', now)` en hero, Próximas y botón QR) aunque el check-in sigue abierto hasta `slot_fin + 30 min`. SALA tiene el mismo bug | `Dashboard.tsx:44`; `MisReservas.tsx:57`; `MiQRProxima.tsx:30` | — (arreglar en ambos) | S |
| A4 | **Horas distintas según la pantalla** (zona del navegador vs del estudio): hero, Mis reservas, agrupación por día, modal de cancelar, WhatsApp a recepción, QR. Helpers ya existen en `timezone.ts:164-179` | `ProximaSesionHero.tsx:35-36`; `MisReservas.tsx:87`; `agruparReservas.ts:19-41`; `CancelarMiReservaModal.tsx:24`; `BotonCancelarReserva.tsx:41`; `MiQR.tsx:227`; `Reservar.tsx:153,386` | `dac89fb` y siguientes | S |
| A5 | **Banner PWA global con `zIndex: 250`** tapa "Confirmar", la bottom-nav y el modal de pago; sale en `/admin` de escritorio y en login; descarte permanente; voseo | `src/App.tsx:18`; `PwaInstallBanner.tsx:96-97,113` | solo landing + member, móvil, 4 s de retraso, reaparece a 90 días (`S:PwaInstallBanner.tsx:38-39,118,131`) | S |
| A6 | **Perfil queda viejo tras pagar desde él** (solo toast, sin `refreshUsuario`) → Reservar sigue diciendo "Necesitas un plan" | `MiSuscripcion.tsx:163-171,609-612`; `Reservar.tsx:58` | reload tras cada cobro (`S:Perfil.tsx:460,540,729`) | S |
| A7 | **Reservar lista todos los estudios sin filtrar por plan/bloqueo/status** y concatena "· Inténtalo otra vez" a errores no reintentables | `Reservar.tsx:90-94,170,206-217` | error inline sin sufijo | S |
| A8 | **Miembro en pausa queda expulsado con "Tu cuenta está suspendida"**: no ve el aviso "Tu membresía está en pausa" ni su historial | `validarStatusCuenta.ts:33-37`; `MemberLayout.tsx:48-71`; grep `pausad` en `src/member` = 0 | `congelada` no toca `usuarios.status`; `EstadoMembresiaBanner.tsx:117-123` | S–M |
| A9 | **Campana sin historial**: solo no leídas, `limit(5)`, "marcar todas" marca 5, sin revertir si falla, sin realtime (`supabase_realtime` grep = 0). La misma campana ya se usa en admin y recepción | `useNotificacionesMiembro.ts:37-39,50-56`; `NotificacionesBell.tsx:38-40` | `S:useNotificaciones.ts:16,42,67-116`; `S:20260613003300:24` | S–M |
| A10 | **El staff no puede activar push**: `ActivarAvisosPush` solo está en el Perfil del miembro → `cron-push` y `avisarStaff` (Sprint 5) no llegan a ningún teléfono. Además sin VAPID el push es no-op silencioso y `cron-push` marca todo como enviado | `src/member/pages/Perfil.tsx:105` (único uso); `_lib/push.ts:26-28`; `cron-push/index.ts:60-73` | `S:AjustesNotificaciones.tsx:31-37`; `S:reception/pages/Ajustes.tsx:33-39`; `console.warn` en `S:_lib/push.ts:28-31` | S |
| A11 | Historial de pagos sin concepto, recibo ni reembolsos (un cargo reembolsado dice "Pagado"); `receipt_url` grep = 0 (pendiente P2 de la #1) | `MiSuscripcion.tsx:504-521`; `stripe-billing-info/index.ts:127-139` | `HistorialPagos` + `ReciboModal` | S |
| A12 | 9 textos "Contacta al estudio" sin enlace; el helper de WhatsApp existe y solo se usa en un sitio. `Terminos.tsx:72` promete "reprogramar" y la app no lo ofrece | `Dashboard.tsx:157`; `carnetMembresia.ts:119`; `validarStatusCuenta.ts:36-69` | `ContactoGymCTA.tsx`, `BurbujasContacto` | S |

### 3.5 Panel admin

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| D1 ✔ | **Paquete híbrido con vigencia 0 días se puede guardar** (`parseInt || 0`, sin CHECK en DB) → nace vencido: el miembro paga y el cron le quema los créditos | `src/admin/pages/Tiers.tsx:586-592,786-790` | "La vigencia debe ser de al menos 1 día" (`S:Tiers.tsx:733-737`) | S |
| D2 | Admin cancela reserva con `UPDATE` directo (pendiente de la #1) y el dashboard ofrece "Cancelar" a reservas `completada`/`no_show` → corrompe asistencia | `crudHelpers.ts:274-341`; `AdminDashboard.tsx:232-245` | RPC `cancelar_reserva_admin` con `RESERVA_NO_CANCELABLE` | S–M |
| D3 | **Centro de pendientes enruta mal**: "Cobros pendientes" manda a `/admin/cobros` (Stripe Connect); "vencidas"/"identidad" a Miembros sin filtro (no lee query params) | `centroPendientes.ts:45,56,67`; `Miembros.tsx:13-14` | `?status=` + `useSearchParams` | S |
| D4 | Tooltip de la gráfica 30 días muestra **el día anterior siempre** (medianoche UTC formateada sin `timeZone`); fecha y horas de "HOY" con reloj del navegador; "Ver detalle" sigue siendo el stub `toast.info('pendiente Sprint Reservas')` | `AdminDashboard.tsx:128-132,168-172,228-230,449-453` | `1310665` | S |
| D5 | Faltan en admin: resetear contraseña del staff en Equipo (backend listo), bloquear/desbloquear acceso (backend listo), cambio de status auditado con etiquetas humanas | `Equipo.tsx` grep `reset` = 0; `MiembroDetalle.tsx:74-77,182-184,196-206` | `S:Equipo.tsx:70-78`; `BloquearAccesoModal.tsx` | S |
| D6 | Ficha del miembro: sin hero/KPIs (asistencias del mes, no-shows, última visita), sin próximas reservas cancelables, tabla cruda con tope 50 | `MiembroDetalle.tsx:44,304-334`; `useAdminData.ts:85` | `MiembroKPIs`, `MiembroProximasReservas`, `MiembroHistorial` | M |
| D7 | "INGRESOS" del dashboard es bruto (no resta reembolsos) y no cuadra con Reportes; "Stripe Price ID" es una perilla muerta con copy falso ("Necesario para el cobro online"); fila de plan muestra "/mensual" a paquetes | `useAdminData.ts:597-621`; `Tiers.tsx:412-413,565,800-821` | `useDineroMes.ts:68-81` | S |

### 3.6 Confiabilidad, tests y CI

| # | Gap | Evidencia EKKO | Referencia SALA | Esf. |
|---|---|---|---|---|
| T1 | **Sin tests SQL conductuales de dinero.** Los 9 archivos de `supabase/tests/` son estructurales (existe / DEFINER / grants) y se pegan a mano; los "contratos" de las migraciones son `position(texto in prosrc)`. P0-1, P0-5, M2, M3, M5 habrían caído con un test "compra paquete con mensual viva → usuario activo" | `supabase/tests/activar_membresia_checks.sql:1-30`; `20260821190000:547-566` | `scripts/test_membresias_gate.sql` (11 casos), `test_gestionar_membresia.sql` (712 l.), `test_membresias_cancelacion.sql` (7 casos), self-tests en 57 migraciones con tenant efímero + rollback | M |
| T2 | E2E: smoke placeholder y apagado; SALA corre 5 smokes reales en chromium+webkit en cada push | `e2e/tests/smoke-landing.spec.ts:1-8`; `ci.yml:48` | `S:e2e/tests/smoke-landing.spec.ts:1-77`, `smoke-signup.spec.ts` | S |
| T3 | Sin test: `cron-push`, `cron-felicitaciones`, `cron-membresias-por-vencer`, `avisosStaff`, `admin-delete-user`, `useTenantConfigEditor`, `autoReload` | — | — | S |
| T4 | Centinela de frescura no vigila `cron-push`; `cron-push` reparte avisos de hasta 24 h (SALA limita a 1 h → tras una caída llegan recordatorios viejos de madrugada); Cron Monitor de Sentry con el mismo slug que SALA (si comparten organización, uno tapa al otro — **confirmar**); ventana de recordatorios 55–70 min (SALA 45–75) | `cron-expirar-membresias/index.ts:36-66,102`; `cron-push/index.ts:45`; `20260620140000:36-37` | `S:cron-push/index.ts:24-27,51` | S |
| T5 | `extraerMontoDeEvento` solo lee `inv.subscription` (forma pre-basil) y el endpoint no fija `api_version`: la cuenta Stripe es compartida con SALA (stripe-node 22 vs 18.5 en EKKO). El día que el default cambie, renovaciones y cobros fallidos quedan sin `usuario_id` | `_lib/stripe.ts:200,326-327,366-367` | misma fragilidad en SALA | S |
| T6 | Índices: ledger por `(membresia_id, created_at)`/`(tenant_id, created_at)`; parcial de recordatorios y de no-shows; `payment_events` por `usuario_id`, `stripe_payment_intent_id`, `(tenant_id, created_at)` | `20260620150000:54-55`; `20260514100600:39-43` | `S:20260524000000:154-157`, `S:20260709170000:17-19`, `S:20260713100000:91` | S |

## 4. P2 — deseable

- **De SALA post-21-ago que sí aplica:** ventana de check-in editable (`config.reserva.ventana_check_in_min` existe y nadie lo lee; las RPC hardcodean 15/30 min; falta el campo en `AjustesReglas`) · sesión de prueba gratis 1 por creador (hoy un tier de $0 es asignable sin límite por recepción) · aviso "tu paquete venció" (solo existe "por vencer") · avisos al staff por cancelación tardía y miembro nuevo · tope diario no excluye re-reservar el mismo slot cancelado tarde · avatares sin `onError` (`Perfil.tsx:39`, `PerfilHeader.tsx:30`, `CheckInDetail.tsx:244`).
- **Miembro:** saldo y costo dentro del modal de confirmar reserva · toast de cancelación que diga si volvió el crédito · banner persistente de estado de membresía · distinguir "falló la carga" de "vacío" (`useReservas.ts:157-183` devuelve `[]` en error → slots "libres" sin red) · carnet marca "Activa" un híbrido con 0 créditos (`carnetMembresia.ts:158`) · selector de fechas cortado a 14 días aunque la regla permite 30 (`Reservar.tsx:301`) · slot propio indistinguible en la grilla · signup acepta "12345678" y cambiar clave no · datos del invitado desde la app · `ErrorBoundary` inline con `resetKeys` · `backend.ts:47-52` muestra "HTTP 502" · aviso de ficha de identidad pendiente · deep link perdido tras login · `index.html:26` dice "desde $800/mes" (el seed es $850) · copy falso "Se descuenta 1 por reserva" con `costo_creditos ≥ 2` · voseo residual.
- **Recepción:** errores en segunda persona en el mostrador ("No te quedan créditos") · lecturas sin distinguir sin-conexión/RLS/no-encontrado ni Reintentar · modales de acción sin `maxHeight`/Escape/focus-trap · día visto en Hoy no persiste · estadísticas de asistencia en la ficha · reloj y contadores en el layout.
- **Admin:** acciones rápidas por fila en Miembros · `GestionarMembresiaModal` con preview · bitácora global · vista de invitados/prospectos · selector de período + PDF + deltas + cohortes en Reportes · ubicación con mapa · recorte de imagen al subir · estado vacío que distinga "sin resultados" de "base vacía" · tooltips ⓘ fuera de Reportes · hooks sin `try/finally` (spinner eterno) · contraseña temporal con `Math.random()` · editor de horarios acepta `fin <= inicio` · código muerto (`useAdminMetrics`, `DemoBanner ?demo=`, "Commitment hasta").
- **Backend/DB:** `cambiar-plan-suscripcion` escribe por `UPDATE` directo sin revisar errores ni fijar fee · `stripe-actualizar-tarjeta` solo reintenta en `past_due` (SALA reintenta toda factura `open`) · pago de invitados extra sin revalidar tope/estado + subs `default_incomplete` huérfanas · cancelar/reactivar no se refleja en DB hasta el webhook · devolución va a la membresía viva actual, no a la debitada · `activar_membresia` sin guard de rol ni `FOR UPDATE` · `no_shows_count` vitalicio · oráculo por mensaje de error entre tenants · historial de estados de cuenta (`usuario_status_historial`) · `dedupe` de React en `vite.config.ts` · `.env.example` y `TENANT_SETUP.md` incompletos.
- **Sigue pendiente de la #1 (§4):** todo salvo `E2E.md` — anticipación en minutos, tope diario por plan, `visible_landing`, paginación de `BuscarMiembro`, Recharts, `LandingPreview`, `devFunctionsPlugin`, `sexo`, "FOTO PRÓXIMAMENTE", módulos por tenant, **facturación SaaS**.

## 5. De SALA post-21-ago que NO aplica (verificado)

`7b1047a`/`fa9f8d9` (el front de EKKO nunca lee `stripe_charges_enabled`; el gate es 100 %
server-side en `_lib/connectBilling.ts:22-27` — **EKKO no tiene ese bug**) · inscripción
(`82ed683`, `387ff95`, `bc3c36a`) · multas (`59b033e`, `b597cbe`, `cd847d3`) · caja
(`7ea3b47`, `d06f0a1`) · tienda (`8ddc9f7`) · multi-gym fases 1–3 · salud y contacto de
emergencia (`72304c8`, `c67216e`). Ya resueltos en EKKO por otra vía: `d253e6d`, `23bac5f`,
`b46e65f`, `ce46849`, `ab375c1`, `9cd1c06`, `67b827f`, `6c5abdb`.

**EKKO ya va por delante de SALA en:** `customer.subscription.updated` + guardia de orden
(`last_sub_event_at`), filtro de cuenta ajena antes de la idempotencia, `CameraModal`
(BarcodeDetector + reintento + fallback), reprogramar con fallo parcial, historial de cambios
en la ficha, 87 archivos de test unitario (SALA: 24).

## 5b. Hallazgo posterior al análisis (solo visible al EJECUTAR)

| # | Bug | Evidencia | Esf. |
|---|---|---|---|
| P0-7 ✔ | **Ningún miembro con paquete de créditos podía reservar.** `trg_creditos_debitar` era `BEFORE INSERT` e insertaba en `membresia_movimientos` una fila con `reserva_id = NEW.id` cuando la reserva todavía no existía; la FK no es diferible → `violates foreign key constraint "membresia_movimientos_reserva_id_fkey"`. Los mensuales no lo veían (no generan asiento). Ninguno de los 7 análisis por lectura lo detectó: apareció al correr `reservar_recurso_atomic` contra un Postgres real. **Dato a confirmar en producción:** si algún miembro con paquete logró reservar alguna vez, su base difiere de las migraciones | `20260620150000_planes_creditos.sql:45,246-250`; `20260702120000_costo_creditos_por_estudio.sql:62-69` | S |

## 6. Plan sugerido

**Sprint A — bloqueantes antes de subir (todos S salvo P0-5):** P0-1 (guard
`v_mem.id = membresia_activa_id` + restaurar `membresia_tier = NULL`) · P0-2 (quitar o gatear
`admin-seed-demo`; **borrar/rotar las cuentas `demo-*` si ya existen en prod**) · P0-3 (leer
`rol` del target; helper `requireStaff()` que también resuelva P0-4 en las ~17 functions) ·
P0-4 (`status='activo'` en `is_admin/is_recepcionista/get_my_rol` + guards de layout) · P0-5
(gate de membresía viva en ambas RPC) · P0-6 (`onManualCheckInSuccess` en `Hoy.tsx`) · M1
(`charge.refunded` + test de paridad) · S1 (`p_duracion_min`) · D1 (vigencia ≥ 1 día + CHECK).
**Con test conductual SQL para cada uno** (T1): es la red que faltó.

**Sprint B — subir:** la secuencia de §1.

**Sprint C — dinero:** M2 · M3 · M4 · M5 · M6 · M7 · M8 · M9 · M10 · M11 · M12 · M13 · M15.

**Sprint D — operación diaria:** recepción R1–R6 (rehacer la ficha por estado de membresía) ·
miembro A1–A8 · push para staff A10 · M14.

**Sprint E — admin y pulido:** D2–D7 · A9 · A11 · A12 · S2–S9 · T2–T6 · P2.

**Decisiones de David que siguen abiertas:** facturación SaaS · `controller` de Connect ·
¿el miembro en pausa entra en modo lectura o se queda fuera con mensaje propio? · ¿reembolso
automático de invitados extra al cancelar? · ¿sesión de prueba gratis como gancho comercial?

## 7. Estado de ejecución (2026-09-20, rama `sprint-0-hotfixes`, SIN commitear)

**Sprint A — hecho.** Verificado: `tsc` OK · `lint` OK · `build` OK · `vitest`
95 archivos / 642 tests OK (569 antes) · los 9 checks de `supabase/tests/*.sql`
corren por primera vez en local y dan `✅ PASS`.

| Ítem | Qué se hizo | Dónde |
|---|---|---|
| Red conductual (T1) | Postgres real embebido (PGlite) que aplica las 79 migraciones y ejecuta las RPC; 25 casos de dinero y acceso. **Comprobado que muerden:** contra el esquema sin los fixes fallan 17 de 25 (`EKKO_DB_HASTA=20260821999999`) | `src/__tests__/db/harness.ts`, `dinero-y-acceso.db.test.ts`; devDependency `@electric-sql/pglite` |
| P0-1 + regresión tier | `sync_membresia_stripe('cancelada')` solo toca `usuarios` si no hay otra membresía viva; vuelve a soltar `membresia_tier` | `20260920100000_sync_stripe_no_castiga_al_vigente.sql` |
| P0-5 + P0-7 | Trigger de débito: sin membresía viva → `EKKO_SIN_MEMBRESIA`; mensual de mostrador vencido → `EKKO_MEMBRESIA_VENCIDA`; pasa a `AFTER INSERT` (arregla la FK). Cubre las dos RPC sin recrearlas | `20260920110000_reserva_exige_membresia_viva.sql`; mensajes en `reservaLogic.ts`, `traducirErrorReserva.ts` (tercera persona en mostrador) |
| S1 | Trigger `reservas_duracion_valida`: miembro = duración del estudio; staff 15 min–8 h; nadie cruza la medianoche | `20260920120000_reserva_duracion_valida.sql` |
| P0-4 | `is_admin/is_recepcionista/get_my_rol` exigen `status='activo'` (`'revocado'`, no NULL); la migración normaliza staff `pendiente_*` y aborta si un tenant quedaría sin admin activo. Helper `_lib/staff` en las **17** functions de staff (`reception-invitados` no estaba en el radar: la encontró el test-guardia). Guards de sesión abierta en `useAdminGuard` y `ReceptionLayout`; Login valida staff con regla propia (`cancelado` no entra). `admin-update-role` activa al ascendido y prohíbe el auto-cambio de rol | `20260920130000_staff_inactivo_sin_poderes.sql`; `netlify/functions/_lib/staff.ts`; `validarStatusCuenta.ts` |
| P0-3 | `puedeOperarSobre`: recepción solo sobre miembros, en `reception-update-member`, `reception-datos-identidad`, `reception-activar-membresia` | ídem + tests de escalada |
| P0-2 | Contraseña demo al azar por corrida (14 caracteres), nunca en el repo; test que falla si reaparece un literal | `admin-seed-demo/index.ts` |
| P0-6 | Hoy abre `CheckInDetail` tras el check-in manual (aviso de membresía + invitados) y pausa el polling; el walk-in también muestra el aviso | `Hoy.tsx`, `lib/avisoMembresia.ts`, `CrearReservaModal.tsx` |
| M1 | Lista única de eventos + `charge.refunded` + test de paridad con `clasificarEvento` | `scripts/stripe-eventos.mjs`, `STRIPE.md` |
| D1 | `validarPlan` (crear y editar) + CHECKs `NOT VALID` en `tiers`/`membresias` que avisan, sin tronar, si hay filas viejas inválidas | `admin/logic/validarPlan.ts`, `20260920140000_tiers_checks.sql` |

**Lo que NO se hizo (requiere a David):** commit · push/PR · aplicar las 17
migraciones (12 de `20260821*` + 5 de `20260920*`) en Supabase · deploy ·
re-ejecutar `scripts/stripe-setup-webhooks.mjs` (para que Stripe empiece a mandar
`charge.refunded`) · **borrar o rotar las cuentas `demo-*@ekkostudio.app` si ya
existen en producción**: su contraseña anterior está en el historial de git.

**Al aplicar `20260920130000`:** si aborta con "no tiene ningún admin con
status=activo", tu propio usuario admin no está `activo`; actívalo y reintenta.

### Sprint C — dinero: hecho (2026-09-20, SIN commitear)

Verificado: `tsc` OK · `lint` OK · `build` OK · `vitest` 97 archivos / **696 tests**
OK · 82 migraciones aplican sobre base limpia · checks SQL manuales `✅ PASS`.
Los 22 casos conductuales nuevos **muerden**: contra el esquema previo fallan 13.

| Ítem | Qué se hizo | Dónde |
|---|---|---|
| M2 | `p_referencia` + `membresias.referencia_pago` único + `FOR UPDATE` del usuario; `clasificarEvento` manda el id del PaymentIntent en los dos eventos del pago; el segundo evento no repite correo ni cancela subs | `20260920150000_activar_membresia_dinero.sql`, `_lib/stripe.ts`, `stripe-webhook` |
| M3 | El paquete nuevo vence en la fecha más lejana; mensual de mostrador del mismo plan apila desde su fin | ídem |
| M4 | `pausada` en el índice único, en cierre/arrastre, en devolución, en `stripe-cancelar-suscripcion` y en las subs previas del webhook; reanudar devuelve los días en pausa y vuelve al status previo; sin doble push | `20260920160000_pausa_y_devoluciones.sql`, `stripe-pausar-membresia` |
| M5 | Un cobro no reactiva a un suspendido/revocado por el admin | `20260920100000` (rama activa) |
| M6 + B4 | 409 humano si hay suscripción viva, cobros o huella de staff | `admin-delete-user` |
| M7 | `llavePrecio`: hash de todos los parámetros de `prices.create` | `_lib/stripe.ts`, `crear-pago-intent`, `cambiar-plan-suscripcion` |
| M8 | `processed_at` + reclamo de eventos huérfanos (503 si está en curso); `success:false` de `sync` → Sentry; timeout de 5 s a Resend | `20260920170000_webhook_eventos_procesados.sql`, `stripe-webhook`, `_lib/email.ts` |
| M9 | Pago fallido → aviso in-app + al equipo aunque no haya email | `stripe-webhook` |
| M10 | Correo de compra de paquete con saldo y vigencia | `_lib/email.ts` (`emailPaqueteComprado`) |
| M11 | `en_venta` validado en servidor | 3 functions de cobro |
| M12 | `p_confirmar_perdida` en el RPC → 409 → la UI pregunta (recepción y admin) | `reception-activar-membresia`, `checkout.ts`, `PerfilMiembroRecepcion`, `MiembroDetalle` |
| D10 | La devolución vuelve a la membresía que pagó | `20260920160000` |

**Queda del Sprint C:** M13 (RPC auditado de ajuste de créditos) y M14 (staff
cancela la suscripción de un miembro) → van con la ficha de recepción en el
Sprint D, que es donde viven sus botones. M15 y M16 esperan decisión de David.
Script de reconciliación Stripe↔DB: pendiente.

**Ahora son 20 migraciones por aplicar:** 12 de `20260821*` + 8 de `20260920*`,
en orden, antes del deploy.

### Sprint D — operación diaria: hecho (2026-09-20, SIN commitear)

Verificado: `tsc` OK · `lint` OK · `build` OK · `vitest` 104 archivos / **772 tests**
OK · 84 migraciones aplican sobre base limpia · checks SQL manuales `✅ PASS`.

| Ítem | Qué se hizo | Dónde |
|---|---|---|
| R0–R3 | Ficha de recepción por ESTADO DE MEMBRESÍA: `accionesDeMembresia` + `MembresiaCard`; una sola carga de la membresía y `recargarTodo` tras cada acción; `EstadoCuentaCard` ya no ofrece "Activar" ni alarma por una pausa | `shared/lib/membresiaAcciones.ts`, `reception/components/perfil/MembresiaCard.tsx`, `PerfilMiembroRecepcion.tsx`, `VigenciaMembresia.tsx` (controlable) |
| R2 + M12 | Asignar / renovar / cambiar plan en un paso, con motivo y confirmación de pérdida de créditos dictada por el servidor (409) | `shared/components/membresia/AsignarPlanModal.tsx` |
| M13 | RPC `staff_ajustar_creditos` + modal | `20260920180000_staff_creditos_y_baja.sql`, `AjustarCreditosModal.tsx` |
| M14 | RPC `staff_cancelar_membresia` + function `staff-cancelar-membresia` + modal | ídem, `netlify/functions/staff-cancelar-membresia/`, `CancelarMembresiaModal.tsx` |
| R4 | No-show durante la sesión tras la tolerancia (libera el estudio) + botón en el modal de Hoy; UPDATE condicionado (R6/B11) | `reception-marcar-no-show`, `ReservasHoyView.tsx` |
| R6 | Trigger que audita la cancelación hecha por el estudio; etiquetas humanas para todas las acciones del historial | `20260920190000_auditar_cancelacion_por_staff.sql`, `HistorialCambios.tsx` |
| U3 | `ModalAccion`: cuerpo con scroll y botones fijos, Escape | `shared/components/membresia/ModalAccion.tsx` (solo los modales nuevos) |
| A1 | Cancelar cualquier reserva desde Mis reservas | `MisReservas.tsx` |
| A2 | Plan fuera de venta sigue siendo el plan del miembro y se puede cancelar | `MiSuscripcion.tsx` |
| A3 | Reserva y QR visibles hasta 30 min después de `slot_fin`; "EN CURSO" | `member/logic/reservasVigentes.ts`, `Dashboard`, `MisReservas`, `MiQRProxima`, `ProximaSesionHero` |
| A4 | Fechas y horas del miembro en la zona del estudio | `agruparReservas.ts` y 7 componentes |
| A5 | Banner PWA: rutas, ancho, retraso, z-index, 90 días | `PwaInstallBanner.tsx` |
| A6 | Sondeo de activación + `refreshUsuario` tras pagar | `MiSuscripcion.tsx` |
| A7 | Aviso previo por plan/restricción; sin "· Inténtalo otra vez" | `Reservar.tsx` |
| A8 | Mensaje propio para la pausa en el login | `shared/lib/pausaMembresia.ts`, `Login.tsx` |
| A10 | Push para admin y recepción | `shared/components/ActivarAvisosPush.tsx`, `AdminDashboard.tsx`, `Hoy.tsx` |

**Queda del Sprint D:** R5 (quitar `status`/plan de "Editar datos" de recepción: hoy
conviven los dos caminos; el servidor ya impide reservar sin membresía) · R7
(cancelar desde la tarjeta de Hoy, check-in de un toque, bloqueo manual con fecha,
búsqueda por teléfono, foto en Hoy) · A8 con la sesión ya abierta (`MemberLayout`
sigue mostrando el mensaje genérico) · A9 (campana con historial) · A11 (recibo y
concepto en el historial de pagos) · A12 (enlaces de contacto) · M16 (aviso por
invitados extra al cancelar). La ficha ADMIN (`MiembroDetalle`) sigue con el flujo
viejo de dos pasos: los modales nuevos son compartidos y se pueden montar ahí en
el Sprint E.

**Ahora son 22 migraciones por aplicar:** 12 de `20260821*` + 10 de `20260920*`.
Y una function nueva: `staff-cancelar-membresia`.

### 2026-09-21 — restos, Sprint E parcial y endurecimiento (SIN commitear)

Verificado: `tsc` OK · `lint` OK · `build` OK · `vitest` 117 archivos / **886 tests** OK
(incluye los 9 checks SQL, que ahora corren en CI) · 91 migraciones aplican en limpio.

| Ítem | Qué se hizo |
|---|---|
| Cliente · pago por hora | Tocar una hora sin plan/saldo ofrece el paquete que alcanza y reserva al acreditarse (`sesionSuelta.ts`, EKKO-082). Corregido un bucle infinito de recargas en Reservar (arrow inline al hook de sondeo). |
| Cliente · cambio de horario | Un solo aviso "Era… Ahora es…" (`staff_avisar_reprogramacion`, `20260920230000`). |
| Cliente · material en admin | Columna "Material" en la ficha admin del miembro. |
| E · ficha admin | Misma tarjeta y modales de membresía que recepción; status auditado con etiquetas humanas. |
| E · D2, D3, D4, D5 | Cancelación admin por RPC (sin opción de no avisar); pendientes con filtros; dashboard en zona del estudio + "Ver detalle" real; reset de clave del equipo. |
| D · A9 | Campana como historial (20, leídos atenuados, navega a `metadata.url`, `cambiar_password` no se descarta). |
| S2–S5 | Último admin en DB · columnas privilegiadas · ledgers inmutables · `_estado_membresia_checkin` sin GRANT (`20260921100000`). |
| T6 · X1 | Índices (`20260921110000`) · checks SQL en CI · smokes e2e reales. |

### 2026-09-21 (tarde) — restos del Sprint D: hecho (SIN commitear)

Verificado: `tsc` OK · `lint` OK · `build` OK · `vitest` 123 archivos / **918 tests** OK ·
smokes e2e 6/6 en Chromium y WebKit (1 skip: el alta desde un plan, porque el proyecto
local no tiene planes en venta hasta aplicar `20260821180000`). Sin migraciones nuevas.

| Ítem | Qué se hizo |
|---|---|
| R5 | "Editar datos" en recepción es solo contacto; status y plan viven en sus tarjetas (EKKO-086). |
| R7 | Check-in de un toque en "Llegando ahora", cancelar desde la tarjeta, búsqueda por teléfono (Hoy y padrón), foto en tarjetas, aviso de ficha/contrato pendiente (EKKO-087). Sin bloqueo manual con fecha: sigue en el E. |
| A11 | Concepto, recibo y reembolsos en el historial de pagos (`conceptoDeCargo`, EKKO-088). |
| A12 | `ContactoEstudio` (WhatsApp con mensaje) en login, Inicio, Reservar y cancelación; Términos sin "reprogramar" (EKKO-089). |
| M16-aviso | Aviso de invitados pagados al cancelar + WhatsApp con folio (EKKO-090). El reembolso automático sigue pendiente de David. |
| A8 | `MemberLayout` distingue pausa de sanción con la sesión abierta (EKKO-090). |
| e2e | Puerto propio (5187): el smoke corría contra el dev server de SALA en el 5173. |

**Queda:** del E: bloquear/desbloquear desde admin (y bloqueo manual con fecha/motivo
en recepción), KPIs en la ficha del miembro, S6–S9 menores. Decisiones de David: M15,
M16 (reembolso), miembro en pausa en modo lectura. **28 migraciones por aplicar**
(12 `20260821*` + 14 `20260920*` + 2 `20260921*`); functions nuevas: `cron-email`,
`cron-material-vencido`, `staff-cancelar-membresia`.
