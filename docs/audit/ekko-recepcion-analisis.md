# EKKO Studio — Análisis exhaustivo del módulo de Recepción

> Documento interno, **factual**, extraído leyendo el código real de
> `src/reception/**` y los archivos/RPCs/tablas que recepción consume.
> Vocabulario EKKO: reservas / recursos (estudios) / sesiones / accesos /
> miembros. Cobertura: estado del repo al momento de escribir (post Bloques
> A–E del rediseño de recepción + fix de logos).
> Lo que no encontré lo digo explícitamente como "no encontrado".

---

## 1. INVENTARIO DE ARCHIVOS

Total bajo `src/reception/`: **48 archivos** (incluyendo tests y un `.gitkeep`).

### 1.1 Shell / layout

- `src/reception/ReceptionLayout.tsx` (84 líneas) — Shell del módulo. Guard de
  rol (recepcionista **o** admin), header con logo (`BrandLogo`) + eyebrow
  "RECEPCIÓN" + nombre del usuario + botón "Salir", `<Routes>` con 5 rutas, y
  `<ReceptionBottomNav>` fijo abajo. Lazy-load de las páginas.

### 1.2 Páginas (`src/reception/pages/`)

- `Hoy.tsx` (14 líneas) — Wrapper trivial: renderiza `<ReservasHoyView/>` dentro
  de `.rec-main`. Es la ruta default `/recepcion`.
- `Checkin.tsx` (141 líneas) — Pantalla de scanner QR dedicada. Lector HID
  (`useScannerHID`) + botón "Abrir cámara" (`CameraModal`) + overlay de
  resultado (`CheckInDetail`). Link "No tengo el QR — buscar en Hoy".
- `BuscarMiembro.tsx` (295 líneas) — Búsqueda del padrón (insensible a
  acentos/mayúsculas, filtrado en cliente) **+ toggle "Buscar / Penalizados"**
  (lista de bloqueados activos). Tap → perfil.
- `PerfilMiembroRecepcion.tsx` (733 líneas) — Hub de gestión del miembro:
  datos, estado, acciones de cuenta (editar/foto/reset/aviso/desbloqueo),
  acciones de reserva (crear/cancelar/reprogramar), notas operativas, historial
  de cambios (audit log).
- `Agenda.tsx` (127 líneas) — Calendario read-only. Toggle Semana/Lista (default
  Semana en desktop, Lista en mobile, persistido en localStorage). **Reusa
  componentes de admin**: `VistaSemana` (shared), `ReservasVistaLista` y
  `DetalleReservaModal` (de `@admin`) en modo read-only (sin `onCancelar`).

### 1.3 Componentes (`src/reception/components/`)

- `ReservasHoyView.tsx` (835 líneas) — **El componente más grande.** Panel del
  día: navegación de día, ocupación, búsqueda + filtro por recurso (persistido),
  secciones "LLEGANDO AHORA" / "RESTO DEL DÍA" / "FALTANTES", check-in manual
  (modal interno `ManualCheckInModal`), marcar no-show y corregir check-in.
- `CheckInDetail.tsx` (206 líneas) — Tarjeta de resultado del check-in QR
  (éxito o error). Auto-cierre a 15s con contador. Muestra ficha del miembro,
  reserva, stats de check-in y `notas_admin`.
- `CameraModal.tsx` (135 líneas) — Cámara para escanear QR con `@zxing/browser`.
  Prefiere cámara trasera, cooldown 1.5s, manejo de error con "Reintentar" /
  "Usar check-in manual".
- `CrearReservaModal.tsx` (494 líneas) — Crear reserva walk-in **y** reprogramar
  (prop `reprogramarDe`). Reusa la lógica de slots del módulo miembro.
- `CancelarReservaRecepcionModal.tsx` (180 líneas) — Confirmación de cancelación
  de una reserva del miembro (motivo opcional).
- `RegistrarMiembroModal.tsx` (442 líneas) — Alta de miembro nuevo en 2 fases:
  formulario → pantalla de credenciales (copiar).
- `EditarMiembroModal.tsx` (173 líneas) — Editar contacto + status + tier. Pide
  **motivo obligatorio** si cambia status o tier.
- `FotoMiembroModal.tsx` (165 líneas) — Tomar/cambiar foto del miembro (cámara
  `getUserMedia` con flip, o archivo). Comprime a JPEG ≤640px en cliente.
- `ResetPasswordModal.tsx` (107 líneas) — Genera contraseña temporal, la muestra
  una vez con botón copiar.
- `DesbloquearModal.tsx` (88 líneas) — Levantar bloqueo por inasistencia con
  **motivo obligatorio**.
- `MarcarNoShowModal.tsx` (118 líneas) — Marcar una reserva como no-show con
  **motivo obligatorio** + aviso de penalización.
- `CorregirCheckinModal.tsx` (117 líneas) — Deshacer un check-in con **motivo
  obligatorio**.
- `MotivoField.tsx` (64 líneas) — Selector reutilizable de motivo (lista
  predefinida + opción "Otro" con texto libre). Lo usan los 3 modales sensibles.
- `ReceptionBottomNav.tsx` (32 líneas) — Bottom-nav de 4 ítems
  (Hoy · Agenda · Miembros · Check-in), reusa clases `ek-bottom-nav`.
- `.gitkeep` (0 líneas) — placeholder.

### 1.4 Hooks (`src/reception/hooks/`)

- `useReservasHoy.ts` (89 líneas) — Carga reservas de un día del tenant con
  polling cada 30s (pausable / visibility-aware). Exporta también `checkInManual`
  (llama el RPC `check_in_manual_atomic`) y un traductor local de errores.
- `useScannerHID.ts` (62 líneas) — Listener global de teclado que detecta input
  de scanner USB/HID (heurística: ≥15 chars en <500ms terminados en Enter).
- `useAuditLogDeUsuario.ts` (51 líneas) — Carga el historial de `audit_log` de un
  miembro (`target_tipo='usuario'`), últimas 20, con estados loading/error/data
  y `recargar`.

### 1.5 Librerías (`src/reception/lib/`)

- `accionesMiembro.ts` (71 líneas) — Wrappers `actualizarMiembro` y
  `resetearPasswordMiembro` (vía `backendPost`) + `imagenABase64Jpeg` (reduce
  imagen a JPEG 640px en canvas). Tipo `MiembroPatch`.
- `accionesReserva.ts` (40 líneas) — Wrappers `marcarNoShow` y `corregirCheckin`
  + constantes de motivos predefinidos (`MOTIVOS_NO_SHOW`,
  `MOTIVOS_CORREGIR_CHECKIN`).
- `reprogramarReserva.ts` (145 líneas) — Orquestación no-atómica de reprogramar
  (cancelar vieja + crear nueva), con decisión de orden y manejo de fallos
  parciales (5 estados de resultado).
- `checkInFeedback.ts` (76 líneas) — Beep (Web Audio API) + vibración
  (`navigator.vibrate`) para confirmar check-in OK/error.
- `miembroStatus.ts` (28 líneas) — Mapa estado → `{label, color, alerta}`.
- `traducirErrorReserva.ts` (30 líneas) — Traduce errores de los RPCs de reserva
  a español; delega códigos compartidos al traductor del módulo miembro.
- `traducirErrorRegistro.ts` (50 líneas) — Traduce errores del alta de miembro.

### 1.6 Tests (`__tests__/`, no se describen en detalle aquí)

`ReceptionLayout.test.tsx`, `components/__tests__/`: CameraModal,
CancelarReservaRecepcionModal, CorregirCheckinModal, CrearReservaModal,
EditarMiembroModal, MarcarNoShowModal, RegistrarMiembroModal.
`hooks/__tests__/`: useAuditLogDeUsuario, useReservasHoy.
`lib/__tests__/`: miembroStatus, reprogramarReserva, traducirErrorRegistro,
traducirErrorReserva. `pages/__tests__/`: Agenda, BuscarMiembro,
PerfilMiembroRecepcion. (15 archivos de test.)

### 1.7 Piezas compartidas que recepción consume (fuera de `src/reception/`)

- **Componentes shared** (`@shared/components/`): `NotasMiembro` (bitácora del
  miembro), `EnviarAvisoModal` (notificación manual), `BrandLogo`, `StatusBadge`,
  `TierBadge`, `EmptyState`, `CopyButton`, `Spinner`, `LoadingScreen`,
  `DemoBanner`.
- **Componentes admin reusados en Agenda** (`@admin/components/`):
  `ReservasVistaLista`, `DetalleReservaModal` (con `onCancelar` opcional →
  read-only). `VistaSemana` vive en `@shared/components/calendario/`.
- **Hooks shared**: `useTenant`, `useToast`, `useAuth`, `useNotasMiembro`,
  `useReservasRango` (Agenda), `useVisibilityAwarePolling`.
- **Lib shared**: `@shared/lib/supabase` (cliente tipado), `@shared/lib/backend`
  (`backendPost`/`backendGet`, inyectan el JWT).
- **Lógica reusada del módulo miembro**: `@member/logic/reservaLogic`
  (`generarSlotsDisponibles`, `generarFechasReservables`, `filtrarRecursosPorTier`,
  `formatHora`, `traducirErrorRPC`) y `@member/hooks/useReservas`
  (`useRecursosDelTenant`, `fetchReservasDelRecurso`, `fetchReservasDelUsuario`).

---

## 2. ARQUITECTURA DE RUTAS

Definidas en `ReceptionLayout.tsx`. El layout se monta en `/recepcion/*` (router
raíz en `src/App.tsx`).

### Guard de acceso (`ReceptionLayout.tsx:25-31`)

```
if (isLoading) return <LoadingScreen/>;
if (!authUser) return <Navigate to="/login" state={{from}} replace/>;
if (!usuario) return <LoadingScreen/>;
if (usuario.rol !== 'recepcionista' && usuario.rol !== 'admin')
  return <Navigate to="/app" replace/>;
```

→ Acceso permitido a **recepcionista O admin**. Cualquier otro rol (miembro,
staff) cae a `/app`. **No hay distinción de permisos por ruta interna**: todas las
rutas de recepción comparten el mismo guard.

### Tabla de rutas (`ReceptionLayout.tsx:95-101`)

| Path | Componente | Permiso |
|---|---|---|
| `/recepcion` (`/`, exacta) | `Hoy` → `ReservasHoyView` | recepcionista o admin |
| `/recepcion/agenda` | `Agenda` | recepcionista o admin |
| `/recepcion/miembros` | `BuscarMiembro` | recepcionista o admin |
| `/recepcion/miembros/:id` | `PerfilMiembroRecepcion` | recepcionista o admin |
| `/recepcion/checkin` | `Checkin` | recepcionista o admin |

### Header y navegación

- **Header** (`ReceptionLayout.tsx:39-76`): `ek-header-glass` con `<BrandLogo
  height={88}>` + eyebrow "RECEPCIÓN", a la derecha el nombre del usuario
  (capitalizado) + botón "Salir" (`signOut`).
- **Bottom-nav** (`ReceptionBottomNav.tsx`): 4 NavLink — Hoy (`LayoutDashboard`),
  Agenda (`CalendarRange`), Miembros (`Users`), Check-in (`ScanLine`). Reusa las
  clases `ek-bottom-nav` (mismas que el bottom-nav del miembro).
- `DemoBanner vista="Recepción"` arriba de todo (`ReceptionLayout.tsx:37`).

---

## 3. PANTALLAS — UNA POR UNA

### 3.1 "Hoy" — panel del día (`pages/Hoy.tsx` → `components/ReservasHoyView.tsx`)

Es la pantalla principal del mostrador. `Hoy.tsx` solo envuelve
`<ReservasHoyView/>` en `.rec-main`.

**a) Layout** (`ReservasHoyView.tsx:240-589`):
- **Barra de navegación de día** (`:242-311`): flecha ◀ + centro "VISTA DEL DÍA"
  / etiqueta de día ("Hoy", "Mañana", "Ayer", o fecha) + flecha ▶. Permite ver
  cualquier día (pasado o futuro), no solo hoy.
- **Línea de ocupación** (`:313-327`): "`N` sesiones · `M` con check-in", o "Sin
  reservas para este día".
- **Búsqueda + filtro** (`:329-382`): input de búsqueda (nombre/email/folio,
  debounce 200ms) + `<select>` "Todos los estudios" / por recurso. El filtro de
  recurso se **persiste en localStorage** (`ekko-recepcion-filtro-recurso`).
- **Pills de filtros activos** (`:384-448`): chips removibles del recurso y la
  búsqueda activa.
- **Secciones de reservas** (`:492-555`):
  - **LLEGANDO AHORA** (eyebrow mostaza, cards con borde resaltado): reservas en
    ventana ±15min (solo si el día visto es hoy).
  - **RESTO DEL DÍA** (o "RESERVAS DEL DÍA" si no es hoy).
  - **FALTANTES** (eyebrow rojo, solo hoy): confirmadas cuyo `slot_fin` ya pasó
    sin check-in. Cada faltante tiene además un botón "Marcar no-show".
- **No hay FAB** (el de cámara se movió a la pantalla Check-in). No hay
  sidebar/footer propios.

**b) Datos** (`hooks/useReservasHoy.ts:30-63`): query directa a
`reservas` filtrada por `tenant_id` + rango `[inicio_día, fin_día)`, ordenada por
`slot_inicio`, con joins:
`*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)`.
Recursos para el filtro: query a `recursos` (`id, nombre`, `activo=true`)
(`ReservasHoyView.tsx:147-162`). Datos derivados: buckets `llegando/resto/faltantes`
(`:199-221`) y `ocupacion` (`:223-230`). **Polling cada 30s**, pausado mientras
hay un modal abierto (`:119-122`).

**c) Acciones**:
- **Tap en una card de reserva** (`ReservaCard`, `:602-691`) → abre
  `ManualCheckInModal`. Disabled si la reserva está `cancelada`/`cancelada_admin`/
  `no_show` (opacidad 0.55).
- **Check-in manual** (`ManualCheckInModal`, `:693-835`): campo "MOTIVO
  (OPCIONAL)", botón "Marcar check-in" → `checkInManual(reserva.id, motivo)` →
  RPC `check_in_manual_atomic`. Feedback sonoro/vibración (`playCheckInSuccess`/
  `Error`). Si la reserva ya está `completada`, muestra "Ya hizo check-in
  (qr|manual)" + botón "Corregir check-in".
- **Marcar no-show** (en FALTANTES, `:541-548`) → abre `MarcarNoShowModal`.
- **Corregir check-in** (desde el modal de check-in completado) → abre
  `CorregirCheckinModal`.
- Tras éxito de cualquiera → `refetch()` de la lista.

**d) Estados especiales**: skeletons en carga inicial (`:451-460`); empty "Sin
coincidencias" si hay filtros sin resultado (`:461-482`); empty "Sin reservas
para hoy/este día" si no hay nada (`:483-491`). Status de cada reserva en badge:
`confirmada`→"PENDIENTE" (pill mostaza), `completada`→"OK", `cancelada`/
`cancelada_admin`→"CANCELADA", `no_show`→"NO SHOW" (`:40-76`).

**e) Desktop/mobile**: mismo layout (single-column), mobile-first. No hay
variante desktop específica.

---

### 3.2 "Check-in" — scanner QR dedicado (`pages/Checkin.tsx`)

**a) Layout** (`Checkin.tsx:56-138`): pantalla centrada con icono `ScanLine` (88px
en círculo mostaza), título "Escaneá el QR del cliente", subtítulo explicativo,
botón "Abrir cámara" (`ek-cta--gold`), y un link "No tengo el QR — buscar en
Hoy" (`→ /recepcion`). Overlay `CheckInDetail` cuando hay resultado.

**b) Datos / acción**: no muestra lista. El scanner USB/HID está activo en background
(`useScannerHID`, pausado si hay cámara/detalle abiertos, `Checkin.tsx:54`). Al
detectar un payload (scanner o cámara) → `handleQRPayload` →
`backendPost('qr-verify', { qr_payload })` (`Checkin.tsx:38`).

**c) Resultado** (`CheckInDetail.tsx`): si `success` → tarjeta verde "CHECK-IN OK"
con avatar, nombre, email, teléfono, estudio, hora, duración, folio, personas
(1+invitados), membresía (TierBadge o "SIN PLAN"), "CHECK-IN HOY"/"CHECK-IN
SEMANA" (stats), y `notas_admin` ("NOTAS DEL MIEMBRO"). Si `error` → tarjeta roja
"NO PUEDE ENTRAR" + mensaje traducido + "Si necesitas anular o aclarar, avisá a
admin." **Auto-cierre a 15s** con contador visible (`CheckInDetail.tsx:45-65`).

**d) Estados**: error de cámara (`CameraModal.tsx:83-121`) muestra "No pudimos
acceder a la cámara" + "Reintentar" + "Usar check-in manual".

**e) Mobile/iPad**: pensado como kiosco; cámara `playsInline muted`, overlay con
marco de escaneo.

---

### 3.3 "Miembros" — búsqueda del padrón (`pages/BuscarMiembro.tsx`)

**a) Layout** (`BuscarMiembro.tsx:99-238`): eyebrow "MIEMBROS", **toggle
segmentado "Buscar / Penalizados (N)"** (`:106-145`), y según el modo:
- Modo **Buscar**: input de búsqueda (con botón limpiar) + lista de resultados.
- Modo **Penalizados**: lista directa de miembros con `bloqueado_hasta > now`.

**b) Datos** (`:62-95`): carga **una sola vez** todos los miembros del tenant
(`usuarios`, `select id, nombre, email, status, membresia_tier, bloqueado_hasta`,
`tenant_id=tenant.id`, `rol='miembro'`, orden por nombre, `limit 1000`). El
filtrado es **en cliente, insensible a acentos y mayúsculas** (normalización NFD
+ strip diacríticos, `:29-35`, `:79-84`), matchea nombre **o** email, tope 50
resultados. Penalizados = filtro local por `bloqueado_hasta` futuro (`:97-102`).

**c) Acciones**: tap en una card (`MiembroCard`, `:248-294`) → navega a
`/recepcion/miembros/:id`. No hay otras acciones desde esta pantalla. El botón
"Registrar miembro" **no se renderiza acá** — ver observación en §9.

**d) Estados** (`:182-235`): error de carga ("No pudimos cargar el padrón"),
empty "Buscá un miembro" (sin query), skeletons (cargando), "Sin coincidencias"
(query sin match). En Penalizados: empty "Sin miembros penalizados". El badge de
cada card es el status (color por `statusMiembro`); en modo penalizados muestra
un badge rojo "HASTA `fecha`".

---

### 3.4 "Perfil del miembro" — hub de gestión (`pages/PerfilMiembroRecepcion.tsx`)

La pantalla más densa. (El comentario de cabecera dice "READ-ONLY (Sprint RP-2)"
pero **ya no es read-only** — ver §observaciones.)

**a) Layout** (`:199-500`):
- Link "Volver a búsqueda".
- **Cabecera**: avatar circular 64px **clickeable** (abre `FotoMiembroModal`) con
  icono cámara; eyebrow "MIEMBRO"; nombre (o email).
- **Banner de estado** (`:254-290`): si el status tiene `alerta` o el miembro está
  bloqueado, muestra label de estado + (si !activo) "Podés activarla en Editar
  miembro" + (si bloqueado) fecha de restricción + botón "Desbloquear ahora".
- **Datos operativos** (`:292-323`): Email, Teléfono (si hay), Plan (TierBadge o
  "Sin plan"), Estado, Inasistencias (`no_shows_count`), "Miembro desde"
  (`created_at`).
- **ACCIONES DE CUENTA** (grid, `:325-342`): "Editar datos", "Cambiar/Tomar
  foto", "Resetear acceso", "Enviar aviso".
- **Crear reserva** (`:344-364`): botón gold; **disabled si status ≠ activo** con
  helper "activá la cuenta en Editar datos".
- **PRÓXIMAS RESERVAS** (`:366-394`): confirmadas futuras, con acciones inline
  "Reprogramar" (disabled si !activo) y "Cancelar".
- **HISTORIAL (N)** (`:396-402`): el resto de reservas (hasta 15), read-only con
  StatusBadge.
- **NOTAS OPERATIVAS** (`:404-407`): `<NotasMiembro miembroId>` (bitácora
  compartida).
- **HISTORIAL DE CAMBIOS** (`:409-412`): audit log del miembro (`HistorialCambios`,
  read-only, humanizado).

**b) Datos** (`:106-130`): dos queries directas:
- `usuarios` con **SELECT explícito** `id, nombre, email, telefono, avatar_url,
  membresia_tier, status, no_shows_count, bloqueado_hasta, created_at` —
  deliberadamente **NO** pide `stripe_customer_id` ni `ob_data` (riesgo R6,
  comentado `:119`).
- `reservas` (`id, slot_inicio, slot_fin, status, folio, recurso_id,
  recurso:recursos(nombre)`, `usuario_id=id`, orden desc, limit 50).
- Audit log vía `useAuditLogDeUsuario(id)`.

**c) Acciones** (cada una abre un modal):
- **Editar datos** → `EditarMiembroModal` (contacto + status + tier, motivo
  obligatorio en sensibles) → `reception-update-member`.
- **Foto** → `FotoMiembroModal` → `reception-update-member` (avatar).
- **Resetear acceso** → `ResetPasswordModal` → `reception-reset-password`.
- **Enviar aviso** → `EnviarAvisoModal` (shared) → `reception-notificar-miembro`.
- **Desbloquear ahora** → `DesbloquearModal` (motivo obligatorio) →
  `reception-update-member` (`unblock:true`).
- **Crear reserva** → `CrearReservaModal` → RPC `reservar_para_miembro_atomic`.
- **Reprogramar** (por fila) → `CrearReservaModal` con `reprogramarDe` →
  orquestación `reprogramarReserva`.
- **Cancelar** (por fila) → `CancelarReservaRecepcionModal` → RPC
  `cancelar_reserva_atomic`.
- Tras editar/foto/desbloqueo → `recargarPerfil` (recarga miembro + audit). Tras
  reset → recarga audit. Tras reserva → recarga reservas.

**d) Estados**: skeleton de carga (`:158-165`); "Miembro no encontrado" (danger,
`:167-186`). Banner de estado para suspendido/pendiente/bloqueado.

**e) Mobile/desktop**: single-column, grid de acciones `auto-fit minmax(140px)`.

---

### 3.5 "Agenda" — calendario read-only (`pages/Agenda.tsx`)

**a) Layout** (`:38-83`): eyebrow "AGENDA" + h1 "Reservas del estudio" + toggle
Semana/Lista. Según el modo renderiza `<VistaSemana>` (shared) o
`<ReservasVistaLista>` (de admin, sin `onCancelar` → read-only). Tap en una
reserva → `<DetalleReservaModal>` (de admin, sin `onCancelar` → read-only).

**b) Datos**: `VistaSemana` usa `useReservasRango` (shared). `ReservasVistaLista`
hace su propia query a `reservas` con filtros (desde/hasta/recurso/estado/búsqueda)
y paginación. Ambos son tenant-scoped y read-only.

**c) Acciones**: **ninguna mutación**. Agenda es solo para VER. Para operar
(cancelar/reprogramar) recepción va al perfil del miembro. Default de vista:
Semana en desktop (`matchMedia min-width:768`), Lista en mobile, persistido en
`ekko-recepcion-vista-agenda`.

**d/e)**: la vista Semana muestra un hint en mobile ("funciona mejor en pantallas
grandes" → "Cambiar a Lista").

---

## 4. FLUJOS COMPLETOS (END-TO-END)

### F1 — Check-in vía QR (el flujo central de kiosco)
1. Recepción está en `/recepcion/checkin` (o el scanner HID está activo en esa
   pantalla). 2. El cliente muestra el QR; el scanner USB lo "tipea" (≥15 chars
   <500ms + Enter) **o** recepción abre la cámara y apunta. 3. `handleQRPayload`
   → `backendPost('qr-verify', {qr_payload})`. 4. La función valida el JWT (firma
   HMAC + expiración) y llama `check_in_atomic`. 5. Overlay `CheckInDetail`:
   verde "CHECK-IN OK" con toda la ficha + beep agudo + vibración, **o** rojo "NO
   PUEDE ENTRAR" + beep grave. 6. Auto-cierra a 15s (o "Listo"/"Entendido").
   **Clics: 0–1** (cámara). **Falla y recuperación**: QR inválido/expirado, ya
   check-in, cancelada, no-show, demasiado temprano/tarde → mensaje traducido;
   recepción puede caer a check-in manual.

### F2 — Check-in manual (cliente sin QR a mano)
1. En "Hoy", buscar/ubicar la reserva en LLEGANDO AHORA o RESTO DEL DÍA. 2. Tap
   en la card → `ManualCheckInModal`. 3. (Opcional) escribir motivo. 4. "Marcar
   check-in" → `check_in_manual_atomic` (ventana más amplia: −30min/+60min). 5.
   Beep/vibración, refetch. **Clics: 2–3.** **Falla**: mismos códigos EKKO_*
   traducidos en el modal (`error` local).

### F3 — Marcar no-show manual
1. En "Hoy" → sección FALTANTES. 2. "Marcar no-show" en la fila →
   `MarcarNoShowModal` (resumen + aviso de penalización). 3. Elegir **motivo
   obligatorio** (predefinidos: "Cliente no se presentó" / "avisó tarde" /
   "doble-reserva", o "Otro"). 4. "Marcar no-show" → `reception-marcar-no-show`
   (status→no_show, `no_shows_count+1`, `bloqueado_hasta = max(actual, now+7d)`,
   audit_log). 5. Toast "Inasistencia registrada", refetch. **Falla**: si la
   reserva no está confirmada / ya tiene check-in / slot no terminó / otro tenant
   → 400/403 traducido a toast.

### F4 — Corregir check-in
1. En "Hoy", tap en una reserva ya `completada` → modal "CHECK-IN COMPLETADO" →
   "Corregir check-in". 2. `CorregirCheckinModal` → **motivo obligatorio**. 3.
   `reception-corregir-checkin` (status→confirmada, limpia
   `check_in_at/by/method`, audit_log). Limitado al **mismo día** (zona
   America/Mazatlan); más viejo → "Escalá a admin".

### F5 — Buscar cliente → ver ficha
1. "Miembros" → escribir nombre/email (≥2 chars, insensible a acentos). 2. Tap →
   `/recepcion/miembros/:id`. 3. Ficha completa. **Clics: 2.**

### F6 — Registrar miembro nuevo (`RegistrarMiembroModal`)
1. Abrir el modal (no encontré un botón visible que lo monte — ver §9). 2.
   Formulario: nombre, email, teléfono (opcional), contraseña temporal
   autogenerada (regenerable). 3. "Registrar miembro" → `fetch` directo a
   `reception-create-member`. 4. Pantalla de **credenciales** (nombre/email/
   contraseña) con "Copiar credenciales" + aviso "PENDIENTE DE ACTIVACIÓN — no
   podrá reservar". 5. "Listo" → `onRegistrado(email)`. **El miembro nace
   `pendiente_pago`, sin tier**; activación es responsabilidad de admin.

### F7 — Editar datos / activar cuenta / cambiar plan
1. Perfil → "Editar datos" → `EditarMiembroModal`. 2. Cambiar nombre/teléfono/
   email/status/tier. 3. Si cambia **status o tier**, aparece `MotivoField`
   (obligatorio). 4. "Guardar" → `reception-update-member`. **Activar una cuenta
   vencida = cambiar status a `activo`** (no hay flujo de cobro: §9 B3).

### F8 — Cambiar/tomar foto
1. Perfil → avatar o "Cambiar/Tomar foto" → `FotoMiembroModal`. 2. Cámara
   (con flip) o subir archivo → se comprime a JPEG ≤640px en cliente. 3. Envía a
   `reception-update-member` (avatar base64).

### F9 — Resetear acceso
1. Perfil → "Resetear acceso" → `ResetPasswordModal` → `reception-reset-password`
   genera contraseña temporal de 12 chars y la muestra una vez (copiar).

### F10 — Desbloquear (levantar penalización)
Dos entradas: (a) banner de estado del perfil ("Desbloquear ahora"); (b) modo
"Penalizados" de Miembros → tap → perfil → desbloquear. → `DesbloquearModal`
(**motivo obligatorio**) → `reception-update-member` (`unblock:true`, limpia
`bloqueado_hasta`, **no** resetea `no_shows_count`).

### F11 — Enviar aviso al miembro
1. Perfil → "Enviar aviso" → `EnviarAvisoModal` (≤500 chars). 2. →
   `reception-notificar-miembro` (inserta en `notificaciones` tipo `aviso_manual`
   + audit_log). El miembro lo ve in-app.

### F12 — Crear reserva walk-in
1. Perfil (status activo) → "Crear reserva" → `CrearReservaModal`. 2. Elegir
   estudio (filtrado por tier del miembro) → fecha (chips, 14 días) → slot. 3.
   (Opcional) notas. 4. "Crear reserva" → `reservar_para_miembro_atomic`. **D1:
   anticipación a 0** → permite walk-ins (slots cercanos no se ocultan).

### F13 — Cancelar reserva del miembro
1. Perfil → fila de PRÓXIMAS → "Cancelar" → `CancelarReservaRecepcionModal`
   (motivo opcional). 2. → `cancelar_reserva_atomic` (como recepción ≠ dueño:
   status→`cancelada_admin` + `cancelada_por` + notifica al miembro). 3. Toast
   "Reserva cancelada. Se le notificó al miembro."

### F14 — Reprogramar reserva
1. Perfil → fila → "Reprogramar" → `CrearReservaModal` con `reprogramarDe`. 2.
   Elegir nuevo slot. 3. "Reprogramar" → `reprogramarReserva` orquesta
   **cancelar + crear** (no atómico). Maneja 5 estados de fallo (ok /
   error_crear / error_cancelar / parcial_sin_cancelar / parcial_sin_recrear),
   **nunca en silencio** — los parciales avisan con instrucción.

### F15 — Ver agenda / detalle de reserva
"Agenda" → Semana o Lista → tap → `DetalleReservaModal` read-only. Sin
mutaciones.

### F16 — Notas operativas
Perfil → "NOTAS OPERATIVAS" (`NotasMiembro`): agregar nota (textarea →
"Agregar nota"), editar/borrar las propias (admin puede todo). PostgREST directo
a `notas_miembro`.

---

## 5. BACKEND / RPCS QUE RECEPCIÓN USA

### 5.1 RPCs SECURITY DEFINER (vía `supabase.rpc` / PostgREST)

**`check_in_atomic(p_reserva_id uuid)`** — llamado por `qr-verify`.
Validaciones: caller `rol IN ('admin','recepcionista')`; reserva existe; mismo
tenant (`EKKO_TENANT_DIFERENTE`); status confirmada (rechaza completada/
cancelada/no_show); ventana −15min/+30min. Escribe status='completada',
`check_in_at`, `check_in_by`, `check_in_method='qr'`. (migración
`20260522100000_logic_fix.sql`, versión L-02.)

**`check_in_manual_atomic(p_reserva_id uuid, p_motivo text)`** — llamado por
`useReservasHoy.checkInManual`. Igual gate de rol + tenant + estado, ventana más
amplia (−30min/+60min), `check_in_method='manual'`, anexa `[Check-in manual:
motivo]` a `notas`. GRANT a `authenticated`.

**`reservar_para_miembro_atomic(p_usuario_id, p_recurso_id, p_slot_inicio,
p_duracion_min, p_invitados, p_notas)`** — llamado por `CrearReservaModal` y
`reprogramarReserva`. Gate: caller admin/recepcionista. D2: el target debe estar
`activo`. D1: **no** valida anticipación mínima (walk-in). Valida tier/recurso,
no-continuas, no doble-booking. (migración RP-1
`20260520100000_recepcion_plus_rp1.sql`.) *No está en los tipos generados → el
front castea `supabase.rpc as any`.*

**`cancelar_reserva_atomic(p_reserva_id, p_motivo)`** — llamado por
`CancelarReservaRecepcionModal` y `reprogramarReserva`. Gate: dueño **o**
`is_recepcionista()`. SEC-FIX H3: si la cancela un tercero, debe ser de su tenant.
Como recepción ≠ dueño → status='cancelada_admin' + `cancelada_por` +
`INSERT INTO notificaciones`. (RP-1 override + `20260521100000_sec_fix.sql`.)

### 5.2 Queries directas (PostgREST, protegidas por RLS)

- `reservas` (lista del día, perfil, recursos) — SELECT.
- `usuarios` (padrón, perfil) — SELECT con columnas explícitas (sin sensibles).
- `recursos` (filtro de Hoy, `useRecursosDelTenant`) — SELECT.
- `notas_miembro` — SELECT/INSERT/UPDATE/DELETE (vía `useNotasMiembro`).
- `audit_log` — SELECT (vía `useAuditLogDeUsuario`).
- `notificaciones` — la escribe el backend (no el front de recepción).

### 5.3 Netlify Functions (vía `backendPost` / `fetch`, todas con `service_role`)

Todas validan: `Bearer JWT`, caller `rol IN ('admin','recepcionista')`, y
**target del mismo tenant** (H3). Las sensibles escriben `audit_log` con el helper
`writeAuditLog`.

| Función | Params | Qué hace | Audit |
|---|---|---|---|
| `qr-verify` | `qr_payload` | Valida JWT del QR (HMAC + exp) y llama `check_in_atomic` | (el check-in deja `check_in_by/method`) |
| `reception-create-member` | `nombre, email, password, telefono?` | Crea auth + fila usuarios; **rol hardcodeado 'miembro'**, status `pendiente_pago`, sin tier | `create_member` |
| `reception-update-member` | `usuario_id, nombre?, telefono?, email?, status?, membresia_tier?, unblock?, avatar?, motivo?` | Edita contacto/status/tier/foto/desbloqueo. **Motivo obligatorio** (≥3) si status/tier/unblock. Bypassa el trigger C2 con service_role | `status_change`, `tier_change`, `unblock`, `contact_change`, `avatar_change` |
| `reception-reset-password` | `usuario_id, motivo?` | Genera contraseña temporal (12 chars), update en Auth | `password_reset` |
| `reception-marcar-no-show` | `reserva_id, motivo` | Replica el cron sobre una reserva: status→no_show + penalización | `no_show_manual` (target=usuario) |
| `reception-corregir-checkin` | `reserva_id, motivo` | Deshace check-in (status→confirmada, limpia columnas), mismo día (TZ Mazatlan) | `checkin_correction` (target=usuario) |
| `reception-notificar-miembro` | `miembro_id, mensaje` | Inserta `notificaciones` tipo `aviso_manual` (in-app) | `notification_sent` (target=usuario) |

> Nota: `reception-create-member` se llama con `fetch` crudo (no `backendPost`)
> para poder leer `result.error` y traducir "email duplicado"
> (`RegistrarMiembroModal.tsx:91-117`).

---

## 6. SISTEMA DE PERMISOS / SEGURIDAD

### 6.1 Frontend
- **Guard de ruta**: `ReceptionLayout` deja entrar solo a `recepcionista`/`admin`
  (`:29-31`). No hay sub-guards por ruta.
- **Gates en UI**: "Crear reserva"/"Reprogramar" disabled si el miembro no está
  `activo`. Perfil hace SELECT explícito **sin** campos sensibles
  (`stripe_customer_id`, `ob_data`).

### 6.2 Backend
- **Helper SQL `is_recepcionista()`**: `rol IN ('recepcionista','admin')`
  (helper functions). `is_admin()`: `rol='admin'` estricto.
- **RLS**: `reservas`/`usuarios` tienen policy de SELECT para `is_recepcionista()`
  del tenant. `notas_miembro`: SELECT/INSERT recepción+admin del tenant;
  UPDATE/DELETE solo autor o admin. `audit_log`: SELECT recepción acotado a
  `target_tipo='usuario'` (admin ve todo).
- **Trigger C2** (`20260521100000_sec_fix.sql`): bloquea que un usuario
  `authenticated` toque columnas privilegiadas (`rol/tenant/status/tier/
  no_shows_count/bloqueado_hasta`). **Recepción lo rodea por diseño**: sus cambios
  sensibles van por Netlify Functions con `service_role` (que no dispara el
  trigger), nunca por PostgREST directo.
- **H1**: `stripe_customer_id` y `ob_data` viven en `usuarios_datos_privados`
  (RLS admin-only) — recepción no los alcanza.
- **H3**: las funciones validan `target.tenant_id === caller.tenant_id`.

### 6.3 Qué NO puede hacer recepción (sí admin)
- Cambiar `rol` de nadie (intocable, C2a + función admin-only).
- Hard-delete de miembros/recursos/tiers.
- CRUD de recursos/tiers, config del negocio (landing/marca/reglas), gestión de
  staff.
- Ver `stripe_customer_id` / `ob_data`.
- Setear status `cancelado` o `pendiente_onboarding` (la UI solo ofrece
  `activo/suspendido/pendiente_pago` — ver §9).
- Pagos/cobranza (no existe para nadie todavía).

### 6.4 Qué SÍ puede recepción (que un cliente no)
- Check-in (QR/manual), ver el padrón completo, ver/crear/cancelar/reprogramar
  reservas de cualquier miembro, registrar miembros, editar contacto/status/tier,
  foto, reset password, desbloquear, marcar no-show, corregir check-in, notas,
  avisos.

---

## 7. AUDITORÍA / BITÁCORA

**Sí existe**, tabla `audit_log` **insert-only** (`20260611100000_audit_log.sql`).
- Columnas: `tenant_id, actor_usuario_id, actor_rol, accion, target_tipo,
  target_id, antes, despues (jsonb), motivo, metadata, creada_at`.
- **Inmutable por construcción**: RLS sin policies de UPDATE/DELETE; INSERT solo
  `service_role` (las funciones). SELECT: admin ve todo del tenant; recepción
  solo `target_tipo='usuario'`.
- **Quién la escribe**: las Netlify Functions sensibles (`writeAuditLog`), y el
  cron `marcar_no_shows` (`no_show_cron`, una entrada por miembro afectado).
- **Quién la ve**: recepción la ve en el perfil del miembro ("HISTORIAL DE
  CAMBIOS", `useAuditLogDeUsuario`), humanizada (status/tier/unblock/no_show/
  corrección/contacto/avatar/password/alta). Muestra acción + actor (rol) + fecha
  + motivo si lo hay.
- Acciones de reserva (cancelar/check-in) tienen además su **propia traza** en
  columnas: `cancelada_por`, `check_in_by`, `check_in_method`.

**`notas_miembro`** es **colaboración editable, NO auditoría** — separada del
audit log a propósito.

---

## 8. PATRONES DE UX DE MOSTRADOR

- **Motivo obligatorio** en acciones sensibles (status/tier/desbloqueo/no-show/
  corrección): `MotivoField` con predefinidos + "Otro". Queda en `audit_log`.
- **No usa "typed confirmation"** (escribir "CANCELAR"/"ELIMINAR") — eso es patrón
  de admin. Recepción confirma con modal + (a veces) motivo. Borrar nota usa un
  doble-tap inline ("¿Borrar?" → ✓/✗).
- **Errores nunca crudos**: `traducirErrorReserva`, `traducirErrorRegistro`, mapas
  EKKO_* → español. Pensado para "cliente delante, no podés trabar".
- **Pesimista, no optimista**: espera el RPC/función y luego `refetch`. Si la red
  falla, toast de error y el estado no cambia (no hay rollback porque no hubo
  cambio local).
- **Scanner doble**: USB/HID en background (`useScannerHID`) + cámara
  (`@zxing/browser`). El HID se pausa cuando hay modales/cámara.
- **Feedback sensorial**: beep (Web Audio) + vibración en cada check-in
  (iOS Safari no vibra — limitación conocida).
- **Auto-cierre** del detalle de check-in a 15s (kiosco que se libera solo).
- **Polling visibility-aware** (30s, se pausa con la tab oculta o con modal
  abierto) — ahorra batería/datos del iPad en turnos largos.
- **Persistencia local**: filtro de recurso de "Hoy" y vista de "Agenda" en
  localStorage.
- **"Llegando ahora"** separado del resto: prioriza visualmente quién está por
  entrar (±15min).
- **Credenciales una sola vez**: alta y reset muestran la contraseña con copiar y
  avisan que se entrega en mostrador; el alta exige cierre explícito (Escape no
  cierra la fase de credenciales).

---

## 9. DEUDAS CONOCIDAS / TODOs / LIMITACIONES

- **Reprogramar no es atómico** (D6): cancela + crea con dos RPCs; maneja
  parciales pero puede dejar al miembro "sin reserva" si el segundo paso falla
  (`reprogramarReserva.ts`, estado `parcial_sin_recrear`).
- **B3 — cambiar tier no toca status**: activar un `pendiente_pago` requiere
  cambiar status a `activo` aparte; cambiar el plan no lo activa (cuenta
  inconsistente). Ligado a que **no hay cobro/Stripe**.
- **Pagos en mostrador: no existen** (no encontrado). El alta deja al miembro
  `pendiente_pago` y delega la activación a admin. `Cobranza` es stub en admin.
- **Recurso fuera de servicio temporal: no existe** (Bloque F pendiente).
- **No-show manual usa `slot_fin < now`** (no el +30min del cron) — recepción
  puede marcarlo apenas pasa el horario; el efecto es idéntico e idempotente.
- **Corregir check-in solo el mismo día** (zona America/Mazatlan); más viejo se
  escala a admin.
- **Audit de no-show/corrección targeteado a `usuario`** (no `reserva`) para que
  recepción lo vea (la RLS le deja leer solo `target_tipo='usuario'`); el
  `reserva_id` va en `metadata`.
- **`reception-update-member` hace read-modify-write** del estado para el audit
  (riesgo teórico de carrera con 2 recepcionistas a la vez sobre el mismo
  miembro; despreciable en mostrador de 1 operador).
- **Contraseñas de alta con `Math.random()`** (`RegistrarMiembroModal.tsx:20-26`),
  no `crypto` — observación de seguridad menor (el reset del backend sí usa
  `randomInt`).
- **Stats de check-in con fallback a 1** (`CheckInDetail.tsx:148-149`): si el RPC
  no devuelve stats, muestra "1" en vez de "—".
- **iOS Safari no vibra** (`checkInFeedback.ts:6`).

---

## 10. CONTEXTO DE USO REAL

Evidencia tomada de comentarios de código, mensajes de commit y `KERNEL.md`:

- **Premisa del producto**: EKKO se lanza con **Cravia** (un creator studio). El
  dueño/admin **NO está físicamente** en el estudio durante la operación →
  recepción debe resolver casi todo en el mostrador sin escalar. (Esto motivó
  los Bloques A–E del rediseño.)
- **Sprints históricos** citados en el código: RP-1..RP-4 ("Recepción Plus"),
  luego Bloques A (gobernanza/audit), B+C (agenda + nueva IA), D (no-show manual
  + corregir check-in), E (notas + aviso).
- **Búsqueda insensible a acentos**: el commit `7a566a5` la introduce; el código
  (`BuscarMiembro.tsx:37-42`) documenta el bug — "busco el nombre y no aparece"
  porque `ilike` de Postgres no ignora acentos (José ≠ jose). Se cambió a cargar
  el padrón y filtrar en cliente con normalización NFD.
- **Polling pensado para el iPad de recepción**: `useReservasHoy.ts:18-28`
  documenta explícitamente "ahorra batería/datos del iPad en turnos largos".
- **Check-in manual con ventana más amplia** que el QR: "la recepcionista decide,
  ya valida visualmente" (`check_in_method.sql:172-173`).
- **Cancelación notifica al cliente** "por el estudio" (D3): el código asume que
  el cliente puede estar mirando su app.
- No encontré tickets/issues externos de Cravia en el repo (solo commits y
  comentarios). "Cravia pidió X" explícito: **no encontrado** más allá de la
  premisa general de operar sin admin presente.

---

## OBSERVACIONES INTERNAS (posibles inconsistencias de EKKO — registradas, NO corregidas)

1. **Comentario obsoleto**: `PerfilMiembroRecepcion.tsx:23-31` dice "Perfil
   READ-ONLY para recepción" y "recepción solo CONSULTA", pero la pantalla es hoy
   un hub de gestión completo (edita status/tier, resetea, desbloquea, etc.). El
   comentario quedó de la época RP-2.
2. **Status no alcanzables desde recepción**: `statusMiembro` mapea
   `pendiente_onboarding` y `cancelado`, pero `EditarMiembroModal` solo ofrece
   `activo/suspendido/pendiente_pago` (y `reception-update-member` solo acepta
   esos 3). Recepción puede *ver* esos estados pero no *setearlos*.
3. **Texto de Faltantes potencialmente engañoso**: "El sistema las marca como
   inasistencia automáticamente" (`ReservasHoyView.tsx:534-535`) — cierto (cron),
   pero ahora recepción también puede marcarlas a mano con el botón de la misma
   sección; el copy no lo menciona.
4. **Dos conceptos de "notas" sobre el miembro**: `notas_admin` (campo privado de
   admin, que recepción **ve** read-only en el detalle de check-in como "NOTAS DEL
   MIEMBRO", `CheckInDetail.tsx:152-157`) y `notas_miembro` (bitácora compartida
   editable en el perfil). Son tablas/campos distintos con propósito distinto;
   fácil confundirlos.
5. **`RegistrarMiembroModal` SIN punto de entrada (confirmado)**: el componente
   existe (442 líneas) y está testeado, pero un `grep` sobre todo `src/` muestra
   que **nadie lo importa ni lo monta** — solo aparece en su propio archivo y en
   su test. Es decir: **el alta de miembro desde el mostrador NO está accesible
   hoy en la UI de recepción** (quedó huérfano tras el rediseño de IA B+C, que
   reemplazó la pantalla que lo contenía). El flujo F6 describe el componente,
   pero en la práctica no hay forma de abrirlo. Feature presente en el código,
   ausente en la experiencia.
6. **`fetch` crudo vs `backendPost`**: `RegistrarMiembroModal` usa `fetch` directo
   a propósito (para leer `error`), mientras el resto usa `backendPost`. Está
   documentado, pero es una inconsistencia de patrón.

---

*Fin del análisis. Documento read-only, no commiteado.*
