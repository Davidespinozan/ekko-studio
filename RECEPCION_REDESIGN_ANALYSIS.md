# RECEPCIÓN — Análisis de rediseño como operación completa

**Tipo:** análisis READ-ONLY (sin cambios de código, sin migración, sin commit)
**Fecha:** 2026-06-11
**Estado:** borrador para revisión conjunta — cada propuesta la vota David
**Premisa de negocio:** EKKO se lanza con Cravia. El dueño/admin NO está físicamente en el estudio durante la operación. Recepción debe resolver casi todo en el mostrador sin escalar.

---

## ⚠️ HALLAZGO QUE CAMBIA EL ENCUADRE (leer primero)

El brief de este análisis describe el estado de recepción "post RP-1..RP-4": buscar miembros, ver perfil read-only, crear/cancelar/reprogramar reserva, registrar miembro — y dice que **cambios de perfil, status, tier, bloqueos y foto están hardgateados para admin**.

**Eso ya no es cierto.** Los tres commits más recientes (10-jun) — `5ec0a2d hub de gestión de miembros (foto, datos, credenciales, desbloqueo)`, `2c6aba3`, `7a566a5` — ya le dieron a recepción, **en producción hoy**:

- Editar nombre, teléfono, email (email también toca `auth`)
- Cambiar **status** (`activo` / `suspendido` / `pendiente_pago`)
- Cambiar **membresia_tier** (`basica` / `pro` / sin plan)
- **Desbloquear** miembro (limpia `bloqueado_hasta` + resetea `no_shows_count` a 0)
- Subir/tomar foto
- Resetear contraseña (genera temporal)

Esto pasa por las Netlify Functions `reception-update-member` y `reception-reset-password`, que usan **`service_role`** — y `service_role` **NO dispara el trigger C2** (`current_user='service_role'`, ver [reception-update-member/index.ts:26-29](netlify/functions/reception-update-member/index.ts#L26-L29) y [20260521100000_sec_fix.sql:37-57](supabase/migrations/20260521100000_sec_fix.sql#L37-L57)).

**Consecuencias para este análisis:**

1. El "hueco" entre admin y recepción es **mucho más chico** de lo que el brief asume. Buena parte del rediseño **ya ocurrió** — sin documento de producto que lo respalde.
2. Tres de las "decisiones de producto que necesitan input del dueño" (¿recepción puede cambiar status? ¿tier? ¿levantar bloqueos?) **ya se decidieron implícitamente en código**, sin sign-off explícito y **sin tabla de auditoría**.
3. La línea de "lo prohibido" que el brief describe (trigger C2 protege status/tier/bloqueo) **ya está rodeada por diseño** para recepción. C2 sólo frena al *miembro* tocando su propia cuenta vía PostgREST; no frena a recepción vía service_role.
4. La única traza de quién hizo qué es una línea de texto libre anexada a `notas_admin` ([index.ts:185-189](netlify/functions/reception-update-member/index.ts#L185-L189)) — y ese mismo campo es **editable/sobrescribible** por admin desde `NotasControl` ([MiembroDetalle.tsx:518-576](src/admin/pages/MiembroDetalle.tsx#L518-L576)). La auditoría se puede borrar sin dejar rastro.

> El resto del documento parte de la **realidad del código**, no del brief.

---

## RESUMEN EJECUTIVO

**Qué tiene recepción hoy (realidad):** un módulo de mostrador casi completo para gestión de miembros y reservas en persona. Ya puede hacer ~12 acciones, incluyendo varias que el brief creía bloqueadas.

**Capacidades nuevas que faltan para operar sin admin:** identifico **~9 capacidades** realmente faltantes (no las ~15 que sugiere el brief, porque la mitad ya existe). De esas 9:
- **3 son operativas-bloqueantes** para abrir sin admin presente.
- **3 son operativas-no-bloqueantes** (mejoran el día a día, no impiden abrir).
- **3 son post-launch / dependen de decisiones no tomadas** (pagos, reportes ricos, notas operativas multi-turno).

**Complejidad estimada del rediseño restante:** MEDIA. La mayor parte es UI sobre RPCs/funciones que ya existen o sobre vistas admin reutilizables cambiando el gate. Lo caro de verdad es **infraestructura de confianza** (audit log real + reversibilidad), no features.

**Top 3 decisiones de producto que necesitan input del dueño (David):**

1. **¿Ratificamos lo que recepción ya puede hacer?** Status, tier y desbloqueo ya están abiertos a recepción sin que nadie lo haya decidido formalmente y sin auditoría confiable. Antes de agregar más, hay que decidir si eso se queda, se acota o se condiciona (p. ej. desbloqueo con razón obligatoria). **Esta decisión es prerrequisito de todo lo demás.**

2. **Tabla de auditoría: ¿la construimos ahora?** Si recepción opera sin admin presente, el dueño necesita saber quién cambió un status, levantó un bloqueo o tocó un plan. Hoy esa traza es frágil (texto libre en `notas_admin`, sobrescribible). Esto es lo único realmente "grande" del rediseño.

3. **Línea dura definitiva.** Confirmar qué queda *sólo* de admin por principio aunque sea operativo: dinero sensible (cuando exista Stripe), gestión de staff (`rol`), configuración del negocio (tiers/precios/horarios/branding), y hard-delete. El `rol` ya está bien protegido (C2a + función admin-only). El resto hay que confirmarlo.

**Bugs / inconsistencias existentes encontrados de paso:** 4 (sección al final, NO mezclados con el rediseño). El más serio: la auditoría de cambios de recepción vive en un campo que admin puede borrar.

---

# PARTE 1 — Mapa de lo que recepción hace HOY

### 1.1 Pantallas accesibles

Ruta raíz `/recepcion/*`, gate en [ReceptionLayout.tsx:29-31](src/reception/ReceptionLayout.tsx#L29-L31): permite `recepcionista` **o** `admin`; cualquier otro rol → `Navigate('/app')`.

| Pantalla | Ruta | Archivo |
|---|---|---|
| Check-in (scanner QR + reservas del día) | `/recepcion` | [Scanner.tsx](src/reception/pages/Scanner.tsx) |
| Buscar miembro | `/recepcion/miembros` | [BuscarMiembro.tsx](src/reception/pages/BuscarMiembro.tsx) |
| Perfil / hub de miembro | `/recepcion/miembros/:id` | [PerfilMiembroRecepcion.tsx](src/reception/pages/PerfilMiembroRecepcion.tsx) |

IA actual: **2 tabs superiores** (Check-in · Miembros). El perfil es subruta de Miembros.

### 1.2 Acciones que puede ejecutar

| Acción | Disparador | RPC / Función backend |
|---|---|---|
| Check-in QR | [Scanner.tsx:33](src/reception/pages/Scanner.tsx#L33) | Netlify `qr-verify` → RPC `check_in_atomic` |
| Check-in manual | [useReservasHoy.ts:66](src/reception/hooks/useReservasHoy.ts#L66) | RPC `check_in_manual_atomic` |
| Buscar miembro (insensible a acentos) | [BuscarMiembro.tsx:54-84](src/reception/pages/BuscarMiembro.tsx#L54-L84) | query directa `usuarios` + normalización NFD en cliente |
| Ver perfil (curado) | [PerfilMiembroRecepcion.tsx:114](src/reception/pages/PerfilMiembroRecepcion.tsx#L114) | SELECT explícito (excluye datos sensibles) |
| Crear reserva (walk-in) | [CrearReservaModal.tsx:218-228](src/reception/components/CrearReservaModal.tsx#L218-L228) | RPC `reservar_para_miembro_atomic` |
| Cancelar reserva | [CancelarReservaRecepcionModal.tsx:50-53](src/reception/components/CancelarReservaRecepcionModal.tsx#L50-L53) | RPC `cancelar_reserva_atomic` (→ `cancelada_admin` + notificación) |
| Reprogramar reserva | [reprogramarReserva.ts:94-145](src/reception/lib/reprogramarReserva.ts#L94-L145) | orquesta `cancelar_reserva_atomic` + `reservar_para_miembro_atomic` |
| Registrar miembro | `RegistrarMiembroModal` | Netlify `reception-create-member` (rol hardcodeado `miembro`) |
| **Editar datos (nombre/tel/email)** | [EditarMiembroModal.tsx:54](src/reception/components/EditarMiembroModal.tsx#L54) | Netlify `reception-update-member` |
| **Cambiar status** | EditarMiembroModal | `reception-update-member` ([index.ts:126-133](netlify/functions/reception-update-member/index.ts#L126-L133)) |
| **Cambiar tier** | EditarMiembroModal | `reception-update-member` ([index.ts:135-142](netlify/functions/reception-update-member/index.ts#L135-L142)) |
| **Desbloquear** | [PerfilMiembroRecepcion.tsx:148](src/reception/pages/PerfilMiembroRecepcion.tsx#L148) | `reception-update-member` (`unblock:true`) |
| **Subir/tomar foto** | [FotoMiembroModal.tsx:79-93](src/reception/components/FotoMiembroModal.tsx#L79-L93) | `reception-update-member` (avatar) |
| **Resetear contraseña** | [ResetPasswordModal.tsx:26](src/reception/components/ResetPasswordModal.tsx#L26) | Netlify `reception-reset-password` |

(En **negrita** lo que el brief creía bloqueado y ya está abierto.)

### 1.3 Qué ve / qué no ve del miembro

**Ve** ([PerfilMiembroRecepcion.tsx:114](src/reception/pages/PerfilMiembroRecepcion.tsx#L114)): `id, nombre, email, telefono, avatar_url, membresia_tier, status, no_shows_count, bloqueado_hasta, created_at` + stats de check-in (hoy/semana, vía qr-verify) + reservas (status, folio, horarios, recurso).

**No ve (por SELECT explícito, R6):** `stripe_customer_id`, `ob_data` (viven en `usuarios_datos_privados`, RLS admin-only — H1). Tampoco `notas_admin` (se usa server-side como traza).

### 1.4 Bloqueos efectivos hoy

- **Gate de ruta:** sólo recepcionista/admin entran a `/recepcion`.
- **RLS:** recepción tiene SELECT amplio sobre `usuarios`/`reservas` del tenant (`is_recepcionista()`), pero **NO** SELECT sobre `usuarios_datos_privados` (requiere `is_admin()`), `payment_events` (admin-only), ni UPDATE directo sobre `usuarios` salvo lo que pase por service_role.
- **Trigger C2:** frena a un *miembro* que intente tocar `rol/tenant/status/tier/no_shows/bloqueado_hasta` de su propia fila vía PostgREST. **No frena a recepción** porque recepción no edita esas columnas vía PostgREST — las edita vía Netlify+service_role.
- **`rol` intocable (C2a):** cambiar rol sólo se puede vía `admin-update-role` (Netlify, admin-only, valida último admin con `count_active_admins`). Recepción no tiene acceso. ✅ Correcto.

---

# PARTE 2 — Inventario admin vs recepción

Recorrido del módulo admin completo ([AdminLayout](src/admin/AdminLayout.tsx), secciones OPERACIÓN / CATÁLOGO / EQUIPO / AJUSTES). Por capacidad: ¿la necesita recepción para operar sin admin? · frecuencia en mostrador · riesgo si la usa mal.

### 2.1 Capacidades que recepción YA tiene (cierre de hueco ya ocurrido)

Editar contacto, cambiar status, cambiar tier, desbloquear, foto, reset password, crear/cancelar/reprogramar reserva, registrar miembro, check-in. → Ver Parte 1. **No son hueco; son deuda de gobernanza** (Parte 3).

### 2.2 Capacidades admin que recepción NO tiene

| Capacidad admin | Archivo / RPC | ¿Recepción la necesita? | Frecuencia mostrador | Riesgo si la tiene |
|---|---|---|---|---|
| **Calendario completo (día/semana/lista con filtros)** | [Calendario.tsx](src/admin/pages/Calendario.tsx), `useReservasRango` | **SÍ** — hoy sólo ve día navegable en `ReservasHoyView`; sin vista semana ni lista filtrable | Alta | Bajo (read-only) |
| **Ver detalle de reserva (folio, cancelada_por, motivos)** | [DetalleReservaModal.tsx](src/admin/components/DetalleReservaModal.tsx) | **PARCIAL** — útil para resolver dudas | Media | Bajo |
| **Marcar no-show manual / corregir check-in** | *no existe en admin tampoco* | **SÍ** (ver hueco real) | Media | Medio (afecta penalización) |
| **Ver/gestionar no-shows (lista, levantar penalización)** | *admin sólo ve conteo en Dashboard; `marcar_no_shows` es cron-only* | **PARCIAL** (desbloqueo individual ya existe) | Baja-Media | Medio |
| **Notas operativas del miembro** | [NotasControl](src/admin/pages/MiembroDetalle.tsx#L518-L576) `notas_admin` | **SÍ** — recepción debería poder dejar/leer notas, hoy sólo admin | Media | Bajo |
| **Notificación manual al miembro** | *parcial: sólo automática al cancelar* | PARCIAL | Baja | Bajo |
| **Dashboard / métricas del día** | [AdminDashboard.tsx](src/admin/pages/AdminDashboard.tsx), `useAdminMetrics` | **PARCIAL** — ocupación/faltantes del día sí; ingresos no aplica aún | Media | Bajo (read-only) |
| **Recurso fuera de servicio temporal** | *no existe; sólo archivar (`activo=false`) admin* | PARCIAL | Baja | Medio (afecta reservas) |
| **Pagos: historial / marcar pagado / efectivo / refund** | [Cobranza.tsx](src/admin/pages/Cobranza.tsx) = **stub (`// TODO Fase 3`)** | N/A todavía | — | Alto (cuando exista) |
| Ver datos sensibles (stripe_customer_id, últimos 4) | `usuarios_datos_privados` (H1) | **NO** (sin caso de uso real hoy) | — | Alto |
| Crear/editar/revocar staff y recepcionistas | [Equipo.tsx](src/admin/pages/Equipo.tsx), `admin-update-role` | **NO** — línea dura | — | Crítico |
| Cambiar rol de un miembro | `admin-update-role` | **NO** — línea dura (C2a) | — | Crítico |
| CRUD de recursos/estudios | [Recursos.tsx](src/admin/pages/Recursos.tsx) | **NO** — configuración de negocio | — | Alto |
| CRUD de tiers/precios | [Tiers.tsx](src/admin/pages/Tiers.tsx) | **NO** — configuración de negocio | — | Alto |
| Config (landing/contacto/reglas/marca) | `Ajustes*` | **NO** — configuración de negocio | — | Alto |
| Hard-delete miembro/recurso/tier | `admin-delete-user`, hard_delete_guards | **NO** — línea dura | — | Crítico |

### 2.3 El hueco REAL (capacidades nuevas a construir)

Depurando lo que ya existe y lo que es línea dura, quedan **9 capacidades**:

1. **Vista de calendario para recepción** (al menos semana + lista filtrable, read-only).
2. **Detalle de reserva** (read-only, para resolver dudas en mostrador).
3. **Marcar no-show manual / corregir un check-in mal hecho** (no existe ni en admin).
4. **Levantar penalización de no-show con razón** (desbloqueo ya existe; falta el caso "razón obligatoria" + ver el listado de quién está penalizado).
5. **Notas operativas del miembro** (leer/escribir, separadas de la auditoría).
6. **Notificación manual al miembro** (aviso puntual).
7. **Panel del día para recepción** (ocupación, llegadas, faltantes — read-only).
8. **Recurso fuera de servicio temporal** (distinto de archivar).
9. **Pagos en mostrador** (efectivo/transferencia) — **bloqueado por D4 y por Stripe inexistente.**

---

# PARTE 3 — Decisiones de producto/seguridad que esto fuerza

### 3.1 Línea de "lo que sigue siendo sólo de admin"

Propuesta (cada punto lo vota David):

| Categoría | Propuesta | Notas |
|---|---|---|
| Gestión de staff (`rol`, crear/revocar recepcionistas) | **Sólo admin** | Ya protegido (C2a + admin-update-role). Mantener. |
| Configuración del negocio (tiers/precios, recursos, horarios, branding, reglas) | **Sólo admin** | Riesgo alto, frecuencia ~0 en mostrador. |
| Hard-delete de datos | **Sólo admin** | Irreversible. Ya gateado. |
| Dinero sensible (stripe ids, refunds) | **Sólo admin** | H1 ya lo aísla. No abrir sin caso de uso. |
| Status / tier / desbloqueo / foto / contacto | **Recepción (ya abierto)** — *ratificar o acotar* | Ver 3.x. |

### 3.2 Trazabilidad — **decisión prioritaria**

**Hoy NO hay tabla de audit log.** Lo que existe:
- `notas_admin`: línea de texto libre anexada por `reception-update-member` ([index.ts:185-189](netlify/functions/reception-update-member/index.ts#L185-L189)). **Editable/borrable por admin** → no es auditoría confiable.
- `reservas.cancelada_por`, `reservas.check_in_by`, `check_in_method`: columnas de traza puntual (sólido, pero sólo para reservas).
- `payment_events`, `notificaciones`: tablas con su propósito, no audit general.

**Propuesta:** crear `audit_log` (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes/después jsonb, creada_at) escrita desde las Netlify Functions con service_role, **insert-only**, sin policy de UPDATE/DELETE para nadie salvo retención. Si recepción opera sin admin, esto deja de ser nice-to-have.

### 3.3 Reversibilidad / razón obligatoria

Acciones críticas que hoy NO piden razón ni son auto-reversibles:
- **Cambio de status** (suspender/activar): sin razón.
- **Desbloqueo**: sin razón ([PerfilMiembroRecepcion.tsx:148](src/reception/pages/PerfilMiembroRecepcion.tsx#L148) manda `unblock:true` y nada más).
- **Cambio de tier**: sin razón (y relevante a monetización — ver D4).

**Propuesta:** razón obligatoria para status, desbloqueo y tier; queda en `audit_log`. Reversibilidad = el propio audit log permite ver el valor anterior y revertir manualmente (no hace falta "undo" automático para v1).

### 3.4 Datos sensibles

**Propuesta:** recepción **no** necesita ver nada de `usuarios_datos_privados` hoy. Único caso plausible futuro: últimos 4 de tarjeta para confirmar identidad de pago — y eso recién aplica cuando exista Stripe (D4). **No abrir el dique sin caso concreto.** Mantener H1.

### 3.5 Trigger C2

Estado real: **C2 ya no aplica a recepción** porque sus cambios van por service_role. No hace falta "repensar el trigger" para abrir status/tier (ya está de facto abierto). Lo que sí: C2 sigue siendo la defensa correcta contra que un *miembro* se auto-edite. **No tocar C2; sí formalizar que la vía service_role es la autorizada y debe escribir audit_log.** `rol` sigue intocable (C2a) — mantener.

### 3.6 Multi-recepcionista / entrega de turno

Si hay 2+ recepcionistas en turnos distintos, necesitan **notas operativas internas** (capacidad #5) y, idealmente, ver en el audit log qué hizo el turno anterior. No hace falta un sistema de "handoff" dedicado para v1; las notas + audit cubren el 80%.

---

# PARTE 4 — Hueco de UI

El `ReceptionLayout` actual (2 tabs: Check-in · Miembros) no aguanta lo nuevo. Esbozo de IA (no diseño detallado). Regla: **mobile-first, ~80% mobile**.

**Propuesta de top-level (bottom-nav móvil, 4 ítems):**

1. **Hoy** — panel del día: llegadas ahora, próximas, faltantes, ocupación. (Fusiona el check-in actual con el panel del día, capacidad #7.)
2. **Agenda** — calendario semana + lista filtrable read-only (capacidades #1, #2).
3. **Miembros** — buscar + hub de perfil (lo actual, ampliado con notas #5, no-show #3/#4, notificación #6).
4. **Check-in** — scanner QR dedicado (acción de alta frecuencia, merece su propio tap).

**Perfil de miembro ampliado** (orden por frecuencia de uso en mostrador):
- Cabecera: foto, nombre, status, tier, badge de bloqueo si aplica.
- Acciones rápidas: crear reserva · check-in · editar.
- Reservas (próximas / historial) — ya existe.
- **Notas operativas** (nuevo, editable) — separado visualmente de la auditoría.
- **Historial de cambios** (audit log de ESTE miembro, read-only) — da confianza al turno siguiente.
- Acciones sensibles plegadas (status, tier, desbloqueo, reset pass) con razón obligatoria.

**Trade-off:** meter reportes ricos en recepción es tentador pero diluye el foco de mostrador. Propongo que "Hoy" tenga sólo lo accionable del día; los reportes históricos quedan en admin.

---

# PARTE 5 — Análisis de impacto

### 5.1 Reutilizable (cambiar sólo el gate) vs construir de cero

**Reutilizable casi directo:**
- `useReservasRango` y los componentes de calendario admin ([VistaSemana](src/admin/pages/Calendario.tsx), [ReservasVistaLista.tsx](src/admin/components/ReservasVistaLista.tsx), [DetalleReservaModal.tsx](src/admin/components/DetalleReservaModal.tsx)): son read-only sobre `reservas`, y la RLS `reservas_read_admin` ya cubre a recepción (`is_recepcionista()`). → mover a `shared/` o exponerlos cambiando el gate. **Capacidades #1, #2 casi gratis.**
- `useAdminMetrics` para el panel del día (#7): read-only; filtrar a lo accionable.
- Componentes shared ya comunes (StatusBadge, TierBadge, EmptyState, etc.).

**No reutilizable / construir de cero (separación de info sensible):**
- Los hooks de `useAdminData.ts` asumen contexto admin y no tienen gate propio; **no** se deben exponer tal cual. Mejor envolver las queries read-only que recepción necesita.
- Notas operativas (#5): hoy `notas_admin` es campo único que mezcla auditoría + notas. Hay que **separar** (ver bug #1) antes de dárselo a recepción.

### 5.2 RPCs / funciones nuevas o ampliadas

- **`audit_log`** (tabla + escritura desde Netlify Functions). — base de 3.2.
- **Ampliar `reception-update-member`** para exigir `motivo` en status/tier/unblock y escribir audit_log.
- **Nueva RPC/función `marcar_no_show_manual(reserva_id, motivo)`** y **`corregir_check_in(...)`** (#3) — no existen ni en admin.
- **Función notificación manual** (#6) — reutilizar inserción en `notificaciones` que ya hace `cancelar_reserva_atomic`.
- **Recurso fuera de servicio temporal** (#8) — nuevo campo/RPC (distinto de `activo=false`).

### 5.3 Cambios en RLS / triggers

- **Mínimos.** La RLS de lectura de recepción ya alcanza `reservas`/`usuarios`. No hace falta abrir nuevas tablas a recepción salvo `audit_log` (insert vía service_role, sin select para recepción salvo el historial filtrado por miembro — decisión a tomar).
- **No tocar C2.** No tocar H1.

### 5.4 Riesgo de regresión sobre fixes aplicados

- **SEC-FIX H1:** riesgo si alguna pantalla nueva de recepción hace `select('*')` sobre `usuarios` y arrastra columnas — pero las sensibles ya están en otra tabla, así que el riesgo está contenido por diseño. Mantener SELECT explícitos.
- **SEC-FIX C2:** riesgo si se agregan UPDATEs directos desde cliente (PostgREST) sobre columnas privilegiadas — disparará C2 y fallará. Todo cambio sensible debe seguir yendo por service_role.
- **H3 (cross-tenant):** las funciones nuevas deben replicar la validación `target.tenant_id === caller.tenant_id` que ya hace `reception-update-member` ([index.ts:103](netlify/functions/reception-update-member/index.ts#L103)).
- **LOGIC-FIX / ERROR-UI-FIX:** sin impacto directo previsto.

### 5.5 ¿Fuerza repensar D4 (modelo de cobro)?

**Sí, parcialmente.** Dos puntos:
- Recepción ya puede cambiar `tier` sin cobrar nada (no hay Stripe). Y el cambio self-serve del miembro ([change-plan](netlify/functions/change-plan/index.ts)) **no toca `status`** (un `pendiente_pago` sigue sin poder reservar). Si recepción cambia tier en mostrador, ¿cobra? ¿activa? Hoy puede dejar cuentas inconsistentes (tier nuevo, status que no acompaña).
- Pagos en mostrador (#9) está 100% bloqueado por D4 + Stripe inexistente. **No se puede dimensionar hasta decidir D4.**

---

# PARTE 6 — Plan tentativo (sin compromisos)

Agrupado en bloques lógicos. Dimensión: 🟢 chico · 🟡 mediano · 🔴 grande.

### Bloque A — Gobernanza (prerrequisito) 🔴 — ✅ HECHO
**Audit log real + razón obligatoria en acciones sensibles + separar notas de auditoría.**
- Entregado: tabla `audit_log` insert-only (`20260611100000_audit_log.sql`), motivo
  obligatorio en status/tier/desbloqueo (UI + backend 400), `notas_admin` separada
  de la auditoría, B4 corregido, historial de cambios en el perfil de recepción.
- Cierra **B1, B2 y B4** (ver abajo). Detalle en `KERNEL.md` → "Bloque A — Gobernanza".
- Pendiente fuera de alcance: UI de admin del audit log global (post-launch si hace falta).

### Bloque B — Agenda de recepción 🟡 — ✅ HECHO
**Calendario semana + lista filtrable + detalle de reserva (read-only), reutilizando admin.**
- Entregado: `pages/Agenda.tsx` (Semana compartida + Lista filtrable + detalle read-only).
  Estrategia híbrida: `useReservasRango` y `VistaSemana` movidos a `@shared/`;
  `ReservasVistaLista` y `DetalleReservaModal` con `onCancelar` opcional (sin ella = read-only).
- Decidido: **no** se cancela/reprograma desde Agenda en v1 (eso vive en el perfil del miembro).
- Detalle en `KERNEL.md` → "Bloque B + C".

### Bloque C — Panel "Hoy" + IA nueva (bottom-nav 4) 🟡 — ✅ HECHO
- Entregado: bottom-nav 4 ítems (Hoy · Agenda · Miembros · Check-in), `pages/Hoy.tsx`
  (ocupación + llegadas + resto + faltantes + check-in manual) y `pages/Checkin.tsx`
  (scanner QR dedicado, sin el panel embebido). `Scanner.tsx` eliminado.
- Sin migración SQL; sin regresiones de Bloque A.

### Bloque D — No-shows y check-in 🟡
**Marcar no-show manual, corregir check-in, levantar penalización con razón, ver penalizados.**
- Depende de: A (audit + razón).
- Riesgo: medio (afecta penalizaciones).
- Prioridad: media.

### Bloque E — Comunicación y notas 🟢
**Notas operativas (separadas de auditoría) + notificación manual.**
- Depende de: A (separar notas_admin).
- Riesgo: bajo.
- Prioridad: media (clave si hay multi-recepcionista).

### Bloque F — Recurso fuera de servicio temporal 🟢
- Depende de: nada.
- Riesgo: medio (afecta reservas existentes — definir qué pasa con reservas ya hechas).
- Prioridad: baja.

### POST-LAUNCH (no bloqueante para abrir Cravia)
- **Pagos en mostrador (#9)** — bloqueado por D4 + Stripe. Post-launch obligado.
- Reportes ricos / históricos — quedan en admin; recepción no los necesita para abrir.
- Handoff de turno dedicado — notas + audit cubren v1.

**Lo verdaderamente bloqueante para "abrir sin admin con red de seguridad":** Bloque A. Todo lo demás es mejora incremental sobre una base que ya funciona.

---

# A CONFIRMAR (dudoso — no afirmado)

1. **¿El status enum de recepción es intencional?** Recepción puede setear `activo/suspendido/pendiente_pago` ([index.ts:38](netlify/functions/reception-update-member/index.ts#L38)) pero NO `cancelado` ni `pendiente_onboarding`; admin sí puede los 5 ([MiembroDetalle.tsx:108-141](src/admin/pages/MiembroDetalle.tsx#L108-L141)). ¿Decisión deliberada o gap? No lo afirmo.
2. **¿`marcar_no_shows` cron-only es suficiente?** Es cron-only (SEC-FIX H5 revocó el grant a authenticated). No encontré UI para marcar no-show puntual ni en admin ni en recepción. Asumo que hoy los no-shows sólo los marca el cron diario — a confirmar que no hay otra vía.
3. **¿"staff" se usa?** El rol `staff` existe en el CHECK pero no encontré gates ni flujos que lo usen. Parece reservado. A confirmar.
4. **Alcance del panel del día (#7):** asumo que recepción quiere ocupación/llegadas, no ingresos (no hay datos de ingresos sin Stripe). A confirmar con David qué métricas de verdad usa en mostrador.
5. **Reservas pasadas:** recepción ve "historial" en el perfil pero no confirmé si puede operar (cancelar/reprogramar) sobre una reserva ya pasada o sólo futuras. El gate por `status !== 'activo'` deshabilita botones, pero el filtro temporal no lo verifiqué a fondo.

---

# BUGS / INCONSISTENCIAS EXISTENTES (encontrados de paso — NO parte del rediseño)

**B1 — La auditoría de cambios de recepción es borrable.** ✅ **CERRADO (Bloque A).** La auditoría se movió de `notas_admin` (borrable por admin) a `audit_log` insert-only. **Severidad: media-alta.**

**B2 — `notas_admin` tiene doble propósito en conflicto.** ✅ **CERRADO (Bloque A).** `notas_admin` dejó de recibir appends de auditoría; vuelve a ser solo notas humanas. La auditoría vive en `audit_log`. **Severidad: media.**

**B3 — Cambio de tier puede dejar la cuenta inconsistente.** Recepción (y el self-serve `change-plan`) cambian `membresia_tier` sin tocar `status`. Un miembro `pendiente_pago` al que recepción le cambia el plan sigue sin poder reservar, sin señal clara de por qué. Con Stripe inexistente esto es tolerable, pero es una trampa de UX/datos. **Severidad: baja-media** (ligado a D4). _Sigue abierto — fuera del alcance de Bloque A._

**B4 — Desbloqueo sin razón ni traza fuerte.** ✅ **CERRADO (Bloque A).** El desbloqueo ahora exige motivo (queda en `audit_log`) y **ya NO resetea `no_shows_count`** — solo levanta `bloqueado_hasta`; el historial de inasistencias se conserva. **Severidad: baja-media.**

---

*Fin del análisis. Nada de esto está commiteado ni implementado. Revisamos juntos y David vota cada propuesta antes de armar sprints.*
</content>
</invoke>
