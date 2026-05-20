# Recepción Plus — Plan de implementación

**Fecha:** 2026-05-20
**Autor:** Claude Code (auditoría, sin cambios de código)
**Objetivo:** elevar el rol `recepcionista` con 4 capacidades de cara al cliente,
sin abrir acceso a gestión del negocio.

**Principio rector:**
- **Recepción** = operación de cara al cliente (mostrador).
- **Admin** = gestión del negocio (config, dinero, staff, datos sensibles).

---

## Estado de ejecución

- **✅ RP-1 — Backend de permisos** (commit en `main`): RPC
  `reservar_para_miembro_atomic`, `cancelar_reserva_atomic` ampliado,
  Netlify Function `reception-create-member`. Migración
  `20260520100000_recepcion_plus_rp1.sql` + tests. Decisiones D1, D2,
  D3, D5 aplicadas. **D4 diferido** (no se tocó `membresias`). **D6**
  (reprogramar) es de RP-3.
  ⚠️ **Pendiente operativo:** aplicar la migración al Supabase de EKKO
  y correr `supabase/tests/rp1_security_checks.sql`.
- **✅ RP-2 — Navegación + búsqueda + perfil read-only** (commit en
  `main`): tabs de recepción (Check-in · Miembros), `BuscarMiembro`,
  `PerfilMiembroRecepcion` (vista nueva read-only, NO reusa
  `MiembroDetalle` — riesgos R3/R6 respetados). Sin backend nuevo.
- **✅ RP-3a — UI crear + cancelar reserva** (commit en `main`):
  `CrearReservaModal` + `CancelarReservaRecepcionModal` colgados del
  perfil. D1 (walk-ins), D2 (botón disabled si no-activo), D3 (RPC
  setea cancelada_admin + notifica). Consume los RPCs de RP-1.
- ⬜ RP-3b — UI reprogramar reserva.
- ⬜ RP-4 — UI registrar miembro.

---

## 1. Cómo se define el rol hoy (TASK 1)

- **Dónde vive:** columna `usuarios.rol` (`text`), CHECK
  `IN ('admin', 'recepcionista', 'staff', 'miembro')`
  ([20260514100200_usuarios.sql:20-21](supabase/migrations/20260514100200_usuarios.sql#L20)).
  Default `'miembro'`. Hay índice `usuarios_rol_idx (tenant_id, rol)`.
- **Roles reales:** `admin`, `recepcionista`, `staff`, `miembro`. `staff`
  existe en el enum pero no tiene tratamiento propio en RLS ni UI — hoy es
  efectivamente equivalente a `miembro` para permisos.
- **NO está en el JWT.** El rol vive solo en la tabla `usuarios`. Las
  policies RLS lo resuelven con funciones `SECURITY DEFINER` que hacen
  `SELECT rol FROM usuarios WHERE auth_id = auth.uid()`.
- **Helpers SQL** ([20260514100700_helper_functions.sql](supabase/migrations/20260514100700_helper_functions.sql)):
  - `get_my_user_id()`, `get_my_tenant_id()`, `get_my_rol()`
  - `is_admin()` → `rol = 'admin'`
  - `is_recepcionista()` → **`rol IN ('recepcionista', 'admin')`** ← clave:
    ya significa "recepción-o-superior". Reusable tal cual.
- **Frontend:** `AuthProvider` hidrata `usuario` desde la tabla `usuarios`
  por `auth_id`; el rol se lee como `usuario.rol` vía `useAuth()`.

---

## 2. Enforcement en RLS — backend (TASK 2)

Fuente: [20260514100800_rls_policies.sql](supabase/migrations/20260514100800_rls_policies.sql)
+ [20260517600000_cancelar_reservas_y_notificaciones.sql](supabase/migrations/20260517600000_cancelar_reservas_y_notificaciones.sql).

| Tabla | SELECT recepción | INSERT recepción | UPDATE recepción | DELETE recepción |
|-------|-----------------|------------------|------------------|------------------|
| `usuarios` | ✅ **todo el tenant** (`usuarios_read_admin` usa `is_recepcionista()`) | ❌ solo `is_admin()` | ❌ solo admin / self | ❌ |
| `reservas` | ✅ **todo el tenant** (`reservas_read_admin` usa `is_recepcionista()`) | ❌ solo `is_admin()` (`reservas_admin_all`) | ❌ solo `is_admin()` | ❌ solo `is_admin()` |
| `recursos` | ✅ (lectura tenant para todo authenticated) | ❌ | ❌ | ❌ |
| `tiers` | ✅ (lectura tenant) | ❌ | ❌ | ❌ |
| `membresias` | ❌ **solo self o `is_admin()`** | ❌ | ❌ | ❌ |
| `tenants` | ✅ (su tenant) | — | ❌ solo admin | — |
| `payment_events` | ❌ **solo `is_admin()`** | ❌ | ❌ | ❌ |
| `notificaciones` | ✅ las propias | ❌ **solo `is_admin()`** | ✅ marcar leída propia | — |

**Hallazgos:**
- Recepción **ya lee** todo `usuarios` y todo `reservas` del tenant. Las
  capacidades 1, 2 y 3 no necesitan ampliar lectura — la lectura ya está.
- Recepción **no puede escribir** reservas ni usuarios por RLS directa.
- Las policies distinguen por rol (`is_admin()` / `is_recepcionista()`),
  no solo por tenant. El modelo de roles en RLS es sólido y consistente.
- `membresias` y `payment_events` son admin-only — bien, son datos de dinero.

### RPCs (SECURITY DEFINER — bypasan RLS, validan rol adentro)

- **`reservar_recurso_atomic`** ([20260514170000_fix_cupos_to_invitados.sql](supabase/migrations/20260514170000_fix_cupos_to_invitados.sql),
  firma `(p_recurso_id, p_slot_inicio, p_duracion_min, p_invitados, p_notas)`):
  reserva **siempre para `get_my_user_id()`** — el llamante. No hay forma de
  reservar para otro usuario. `GRANT ... TO authenticated` (cualquier rol).
- **`cancelar_reserva_atomic`** ([rpc_reservar.sql:163-211](supabase/migrations/20260514100900_rpc_reservar.sql#L163)):
  permite cancelar solo si `usuario_id == get_my_user_id() OR is_admin()`.
  **Recepción NO puede.** Setea `status='cancelada'`, no inserta notificación
  ni `cancelada_por`.
- **`check_in_*_atomic`** ([20260514120000_rpc_check_in.sql:42](supabase/migrations/20260514120000_rpc_check_in.sql#L42)):
  valida `v_rol IN ('admin', 'recepcionista')` — **precedente exacto** de un
  RPC que ya habilita recepción correctamente. El patrón a copiar.
- Cancelación admin: `crudHelpers.cancelarReserva` hace un **UPDATE directo**
  (no RPC) con `status='cancelada_admin'` + `cancelada_por` + INSERT en
  `notificaciones`. Depende de las policies `reservas_admin_all` y
  "notificaciones admin crea" → **es un camino admin-only**.

---

## 3. Enforcement en UI — frontend (TASK 3)

- **Routing** ([App.tsx](src/App.tsx)): 4 layouts por path —
  `/app/*` → MemberLayout, `/admin/*` → AdminLayout,
  `/recepcion/*` → ReceptionLayout, `/*` → PublicLayout.
- **Guards de layout:**
  - `ReceptionLayout` ([ReceptionLayout.tsx:17](src/reception/ReceptionLayout.tsx#L17)):
    `if (rol !== 'recepcionista' && rol !== 'admin') → <Navigate to="/app">`.
  - `AdminLayout`: guard equivalente para admin (recepción que escriba
    `/admin/...` es rebotada). **Recepción no puede ver pantallas admin.**
- **Decisión de vistas:** por rutas separadas (un layout por rol), no por
  componentes condicionales. Recepción hoy tiene **una sola ruta**:
  `/recepcion` → `Scanner`.
- **Netlify Functions:**
  - `admin-create-user` y `admin-delete-user` validan
    `adminProfile.rol !== 'admin' → 403`. **Excluyen a recepción.** Usan
    `service_role` (bypasan RLS); el gate es el check de rol propio.

**Conclusión:** la separación admin/recepción es por capas (layout + guard +
Netlify Function role-check). Sólida. Recepción está bien contenida hoy —
el trabajo es *abrir con precisión* 4 puertas, sin romper el resto.

---

## 4. Inventario admin-only hoy (TASK 4)

| Capacidad nueva | ¿Existe UI hoy? | Dónde |
|-----------------|-----------------|-------|
| Crear reserva para un miembro | ❌ **No existe en ningún módulo** | Ni admin ni recepción. El único `reservar` es el del propio miembro (`/app/reservar`). |
| Cancelar reserva de un miembro | ✅ admin | `DetalleReservaModal` → `CancelarReservaModal` → `crudHelpers.cancelarReserva` |
| Reprogramar reserva | ❌ **No existe** | Nadie. Hoy = cancelar + crear de nuevo, manual. |
| Ver perfil de miembro | ✅ admin | `/admin/miembros/:id` → `MiembroDetalle` (lectura **y edición**: status, tier, rol, notas, avatar, reset password) |
| Crear/invitar miembro | ⚠️ parcial | `CrearAccesoModal` crea **staff** (admin/recepcionista). El alta de miembro real es el signup público (`fake-signup`). No hay "registrar miembro" en mostrador. |

**Conclusión:** 2 de las 4 capacidades (crear reserva, reprogramar) son UI
nueva para todos. Ver-perfil y crear-miembro existen parcialmente pero
atadas a admin.

---

## 5. Plan de implementación por capacidad (TASK 5)

### Capacidad 1 — Crear reserva para un miembro

- **Backend:** el RPC `reservar_recurso_atomic` reserva para el llamante.
  Necesita un **RPC nuevo** que acepte `p_usuario_id` y valide que el
  llamante es recepción/admin:

  ```sql
  CREATE OR REPLACE FUNCTION reservar_para_miembro_atomic(
    p_usuario_id uuid,
    p_recurso_id uuid,
    p_slot_inicio timestamptz,
    p_duracion_min integer,
    p_invitados integer DEFAULT 0,
    p_notas text DEFAULT NULL
  ) RETURNS reservas
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE
    v_rol text := get_my_rol();
    v_tenant_id uuid := get_my_tenant_id();
  BEGIN
    -- Gate de rol (mismo patrón que check_in_*_atomic)
    IF v_rol NOT IN ('admin', 'recepcionista') THEN
      RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin';
    END IF;
    -- El miembro objetivo debe ser del MISMO tenant
    IF NOT EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = p_usuario_id AND tenant_id = v_tenant_id
    ) THEN
      RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro de otro tenant';
    END IF;
    -- ... reutilizar la lógica de validación de reservar_recurso_atomic
    --     (recurso activo, tier, anticipación, no-continuas, slot libre)
    --     pero con usuario_id = p_usuario_id en el INSERT.
  END; $$;
  GRANT EXECUTE ON FUNCTION reservar_para_miembro_atomic(...) TO authenticated;
  ```

  Recomendación: extraer la validación común de `reservar_recurso_atomic`
  para no duplicarla. **Decisión D1** (ver §7): ¿recepción puede saltarse la
  regla de `anticipacion_min_horas`? (cliente en mostrador quiere reservar
  *ahora*, pero la regla pide ≥24h). Probablemente sí — recepción debería
  poder reservar walk-ins.

- **UI:** pantalla nueva en `/recepcion` — `CrearReservaRecepcion`. Reutiliza
  la lógica de slots de `@member/logic/reservaLogic` (`generarSlotsDisponibles`).
  Flujo: buscar miembro → elegir recurso → elegir fecha/slot → confirmar.
- **Guard UI:** nueva ruta dentro de `ReceptionLayout` (ya gateado por rol).
- **Riesgo:** que recepción reserve para un miembro de otro tenant → el RPC
  lo valida con `tenant_id`. Que reserve a un miembro `suspendido`/`cancelado`
  → decidir si se permite (probablemente no — **D2**).

### Capacidad 2 — Cancelar / reprogramar reserva

- **Cancelar — Backend:** ampliar `cancelar_reserva_atomic` para aceptar
  recepción. Cambio mínimo en [rpc_reservar.sql:188](supabase/migrations/20260514100900_rpc_reservar.sql#L188):

  ```sql
  -- ANTES
  IF v_reserva.usuario_id != v_user_id AND NOT is_admin() THEN
  -- DESPUÉS
  IF v_reserva.usuario_id != v_user_id AND NOT is_recepcionista() THEN
  ```

  `is_recepcionista()` ya cubre recepción + admin, así que el cambio es de
  una palabra. **Pero** hay que decidir el `status` resultante (**D3**):
  el RPC pone `status='cancelada'` (= "el miembro canceló"). Una cancelación
  hecha por recepción es semánticamente `cancelada_admin`. Propuesta: el RPC
  detecta si el llamante ≠ dueño y en ese caso setea `cancelada_admin` +
  `cancelada_por = get_my_user_id()`. Y, como hace el admin hoy, insertar
  una fila en `notificaciones` (el RPC es SECURITY DEFINER → puede insertar
  sin chocar con la policy admin-only de notificaciones).

- **Reprogramar — Backend:** no existe. Es la pieza más pesada. Opciones:
  - **A (simple):** reprogramar = cancelar la actual + crear una nueva.
    Dos RPCs ya existentes/propuestos, orquestados desde la UI. La reserva
    vieja queda `cancelada_admin`, nace una nueva con folio nuevo.
  - **B (atómico):** RPC `reprogramar_reserva_atomic` que en una transacción
    cancela y crea. Más correcto (no hay estado intermedio), más trabajo.
  - Recomendación: **A para el primer release**, B si el folio nuevo/folio
    viejo confunde operativamente.
- **UI:** botón "Cancelar" y "Reprogramar" en una vista de detalle de
  reserva accesible desde recepción (ver capacidad 3 / búsqueda).
- **Riesgo:** que recepción cancele reservas ya pasadas o ya canceladas →
  el RPC ya valida `status='confirmada'` y `slot_inicio > now()`.

### Capacidad 3 — Ver perfil de un miembro (lectura)

- **Backend:** **casi todo ya es accesible.**
  - `usuarios` — recepción ya lee todo el tenant (incluye `membresia_tier`,
    `status`, `bloqueado_hasta`, `no_shows_count`, `notas_admin`).
  - `reservas` (historial) — recepción ya lee todo el tenant.
  - **Falta `membresias`** si se quiere mostrar "reservas restantes" /
    detalle de plan. Hoy `membresias` es `is_admin()`-only. Si EKKO/Cravia
    usa plan por acceso de tier (no por conteo de clases), `membresia_tier`
    en `usuarios` puede alcanzar y **no haría falta tocar `membresias`**
    (**D4**). Si sí se necesita, ampliar la lectura:

    ```sql
    DROP POLICY IF EXISTS membresias_read_recepcion ON membresias;
    CREATE POLICY membresias_read_recepcion ON membresias
      FOR SELECT TO authenticated
      USING (tenant_id = get_my_tenant_id() AND is_recepcionista());
    ```

- **UI:** vista `PerfilMiembroRecepcion` en `/recepcion` — **solo lectura**.
  Reusa los bloques de `MiembroDetalle` pero SIN los controles de edición
  (status, tier, rol, notas, avatar, reset password). Muestra: nombre,
  contacto, plan/tier, status, próximas reservas, historial, no-shows.
- **Riesgo:** `MiembroDetalle` mezcla lectura y edición — **no reusar el
  componente admin tal cual**; hay que crear una vista nueva read-only o
  parametrizar `MiembroDetalle` con un modo `readOnly`. Reusar el de admin
  directo expondría reset-password y cambio de rol a recepción. **NO hacerlo.**

### Capacidad 4 — Registrar / invitar un miembro nuevo

- **Backend:** la Netlify Function `admin-create-user` valida
  `rol === 'admin'`. Cambio: permitir también a `recepcionista`, **pero
  forzando `rol = 'miembro'`** — recepción nunca puede crear staff.

  ```ts
  // admin-create-user/index.ts — lógica propuesta
  const esAdmin = adminProfile.rol === 'admin';
  const esRecepcion = adminProfile.rol === 'recepcionista';
  if (!esAdmin && !esRecepcion) return forbidden('Sin permiso');
  // Recepción solo puede crear miembros, nunca staff:
  if (esRecepcion && body.rol !== 'miembro') {
    return forbidden('Recepción solo puede registrar miembros');
  }
  ```

  Alternativa más limpia: una Netlify Function nueva `reception-create-member`
  que hardcodea `rol='miembro'` y valida `rol IN ('admin','recepcionista')`
  — evita tocar la función admin y deja el contrato explícito. **Recomendado**
  (D5).
- **UI:** modal `RegistrarMiembroModal` en `/recepcion` — reutiliza el
  layout de `CrearAccesoModal` (nombre, email, password temporal). Muestra
  las credenciales creadas para dárselas al cliente (mismo patrón
  `CredencialesCreadasModal`), ya que no hay email transaccional (Resend
  pendiente).
- **Riesgo:** que recepción cree un usuario con `rol` elevado → bloqueado
  por el hardcode `rol='miembro'`. Que el tenant se infiera mal → la
  función ya toma el `tenant_id` del caller, no del body.

---

## 6. Matriz de permisos consolidada (TASK 6)

| Acción | Miembro | Recepción | Admin |
|--------|:-------:|:---------:|:-----:|
| Ver/crear/cancelar sus propias reservas | ✅ | — | — |
| Hacer check-in (QR / manual) | — | ✅ | ✅ |
| Ver agenda del día | — | ✅ | ✅ |
| **Buscar cualquier miembro del padrón** | — | ✅ **(nuevo)** | ✅ |
| **Crear reserva para un miembro** | — | ✅ **(nuevo)** | ✅ |
| **Cancelar reserva de un miembro** | — | ✅ **(nuevo)** | ✅ |
| **Reprogramar reserva de un miembro** | — | ✅ **(nuevo)** | ✅ |
| **Ver perfil de miembro (lectura)** | — | ✅ **(nuevo)** | ✅ |
| **Registrar/invitar un miembro nuevo** | — | ✅ **(nuevo)** | ✅ |
| Editar datos de miembro (status, tier, notas) | — | ❌ | ✅ |
| Reset password de un miembro | — | ❌ | ✅ |
| Eliminar miembro (hard delete) | — | ❌ | ✅ |
| Crear / editar / revocar staff | — | ❌ | ✅ |
| Cambiar rol de un usuario | — | ❌ | ✅ |
| Config: precios, tiers, branding, CMS | — | ❌ | ✅ |
| Reportes financieros / `payment_events` | — | ❌ | ✅ |
| Ajustes del tenant | — | ❌ | ✅ |

**Lo prohibido se mantiene prohibido** porque: staff/config/tenant/dinero
siguen detrás de `is_admin()` en RLS y de los guards de `AdminLayout` +
el role-check de las Netlify Functions admin. Ningún cambio propuesto
toca esas policies.

---

## 7. Riesgos y decisiones (TASK 7)

### Riesgos de seguridad

| # | Riesgo | Mitigación |
|---|--------|-----------|
| R1 | Ampliar escritura de reservas a recepción → reservar en otro tenant | Los RPCs validan `tenant_id = get_my_tenant_id()` y que el miembro objetivo sea del mismo tenant. |
| R2 | Recepción cancela reservas que no debería (pasadas, ajenas a su tenant) | El RPC ya valida `status='confirmada'`, `slot_inicio > now()`, y tenant. |
| R3 | Reusar `MiembroDetalle` de admin → expone reset-password y cambio de rol a recepción | **NO reusar el componente tal cual.** Vista read-only nueva o `MiembroDetalle` con modo `readOnly`. |
| R4 | Recepción crea staff disfrazado de miembro | Hardcodear `rol='miembro'` en la función; rechazar cualquier otro `rol`. |
| R5 | Ampliar `membresias` SELECT a recepción expone datos de plan | `membresias` no guarda hashes ni tarjetas (eso está en `payment_events` / Stripe). Aun así, ampliar solo si "reservas restantes" lo exige (D4). `payment_events` queda intacto admin-only. |
| R6 | `usuarios` SELECT de recepción ya incluye `notas_admin`, `stripe_customer_id`, `ob_data` | Ya es así hoy (no es un cambio nuevo). La vista de recepción debe **no renderizar** `stripe_customer_id` ni `ob_data`. `notas_admin` ya se muestra a recepción en check-in por diseño. |
| R7 | El rol no está en el JWT — cada check RLS hace un `SELECT` a `usuarios` | Es el modelo actual, funciona; no lo cambia este sprint. Solo nota de deuda futura (custom claims). |

### Decisiones que necesitan input de David (antes de codear)

- **D1 — Anticipación:** ¿recepción puede saltarse `anticipacion_min_horas`
  para reservar walk-ins en el momento? (Recomendado: sí.)
- **D2 — Miembro no-activo:** ¿recepción puede crear reserva para un miembro
  `suspendido`/`pendiente_pago`? (Recomendado: no, mismo criterio que el
  RPC actual.)
- **D3 — Status de cancelación por recepción:** ¿`cancelada` o
  `cancelada_admin`? (Recomendado: `cancelada_admin` + `cancelada_por`, y
  notificar al miembro vía `notificaciones`.)
- **D4 — "Reservas restantes":** ¿el modelo de Cravia es acceso-por-tier
  (ilimitado dentro del tier) o conteo de clases? Si es por tier,
  **no hace falta tocar `membresias`**. Si es por conteo, sí.
- **D5 — Crear miembro:** ¿función nueva `reception-create-member`
  (recomendado, contrato explícito) o ampliar `admin-create-user`?
- **D6 — Reprogramar:** ¿opción A (cancelar+crear, folio nuevo) o B (RPC
  atómico)? Recomendado A para el primer release.

### Estimación de alcance

No entra en un solo sprint. Propuesta de fases:

- **RP-1 — Backend de permisos:** RPC `reservar_para_miembro_atomic`,
  ampliar `cancelar_reserva_atomic`, (opcional) policy `membresias`,
  decisión D5. Migraciones + tests de los RPCs. **1 sprint.**
- **RP-2 — Búsqueda + perfil read-only:** búsqueda de padrón en
  `/recepcion` + vista `PerfilMiembroRecepcion`. **1 sprint.**
- **RP-3 — Crear/cancelar/reprogramar reserva (UI):** las pantallas de
  recepción que consumen los RPCs de RP-1. **1–2 sprints** (reprogramar
  es lo más pesado).
- **RP-4 — Registrar miembro (UI):** modal + función. **1 sprint.**

Total realista: **4–5 sprints chicos.** Recomiendo cerrar RP-1 primero
(es la base de seguridad) y validar los RPCs con tests antes de tocar UI.

### Deuda / observaciones colaterales

- `dev_crear_recepcionista` ([20260514120000_rpc_check_in.sql:119](supabase/migrations/20260514120000_rpc_check_in.sql#L119))
  está marcada "DEV ONLY: eliminar antes de producción". Sigue viva. No es
  de este sprint, pero conviene removerla antes del launch.
- El rol `staff` existe en el enum pero no tiene semántica propia. Si no se
  va a usar, considerar removerlo del CHECK en una migración futura para no
  dejar un estado ambiguo.

---

## Resumen ejecutivo

El modelo de roles de EKKO es **sólido y consistente** (RLS por rol con
helpers `is_admin()` / `is_recepcionista()`, guards de layout, role-check en
Netlify Functions). Eso hace que abrir las 4 capacidades sea **acotado y
seguro** — no hay que rediseñar nada.

**Lo que ya está a favor:**
- Recepción **ya lee** todo `usuarios` y `reservas` del tenant → búsqueda de
  padrón, ver perfil e historial casi no necesitan backend nuevo.
- `is_recepcionista()` ya existe y significa "recepción-o-superior".
- `check_in_*_atomic` es el precedente exacto de un RPC que habilita recepción.

**Lo que hay que construir (todo backend es aditivo, nada se relaja de más):**
1. RPC `reservar_para_miembro_atomic` (nuevo).
2. `cancelar_reserva_atomic`: 1 línea (`is_admin()` → `is_recepcionista()`)
   + decisión de `status`/notificación.
3. (Opcional) policy SELECT de `membresias` para recepción.
4. Función `reception-create-member` (nueva, `rol='miembro'` hardcodeado).
5. UI: 3–4 pantallas nuevas en `/recepcion`, **sin reusar `MiembroDetalle`
   de admin tal cual** (riesgo R3).

**Lo prohibido sigue prohibido** sin tocar una sola policy de admin:
staff, config, tenant, dinero y hard-delete quedan detrás de `is_admin()`.

**6 decisiones (D1–D6)** necesitan tu input antes de codear. La más
importante: **D4** (modelo de membresía — define si se toca `membresias`).
