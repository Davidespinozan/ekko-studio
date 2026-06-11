# EKKO Studio — Arquitectura del Kernel SaaS

> Este documento captura las decisiones arquitectónicas del producto
> replicable que se está construyendo a partir de EKKO Studio.
> El kernel es lo que se va a extraer cuando vendamos a clientes
> más allá de Cravia.

## Filosofía

EKKO es un **SaaS multi-tenant** desde el día 1. Cravia es el
primer cliente, no el único. Cada decisión técnica considera:

1. ¿Esto va a ser igual para todos los tenants? → al kernel
2. ¿Esto va a variar por tenant? → al config jsonb
3. ¿Esto va a variar por vertical (creator studio vs yoga)? →
   pendiente Sprint E (vocabulario configurable)

## Capas del producto

### Capa 1: Kernel (universal, no toca al replicar)

- Auth con Supabase
- Layouts: PublicLayout, MemberLayout, AdminLayout
- RPC `reservar_recurso_atomic` con guards de status, anticipación,
  horario, tier, max_invitados, continuas, overlap
- Sistema de tiers con beneficios y reglas (max_invitados)
- Pagos: Stripe (Sprint pendiente)
- CMS de landing: hero, footer, cta_final editables
- Bucket público de fotos por tenant (`estudios/`)
- TenantProvider con resolución por slug (subdomain o fallback)

### Capa 2: Dominio (configurable por instancia)

- `tenants.config.landing.*` — textos de landing por tenant
- `tenants.config.contacto.whatsapp_e164` — contacto por tenant
- `tenants.config.reserva.*` — reglas de reservación por tenant
- `tenants.config.penalizaciones.*` — penalizaciones por tenant
- `tiers` table — nombres, precios, beneficios, reglas por tenant
- `recursos` table — estudios/salas con foto, capacidad, equipo

### Capa 3: Branding (data-driven, pendiente Sprint D)

- `tenants.branding.logo_url` — logo principal
- `tenants.branding.logo_url_dark` / `logo_url_light` — variantes
- `tenants.branding.og_image_url` — Open Graph
- `tenants.branding.favicon_url` — favicon dinámico
- `tenants.branding.color_*` — colores dinámicos (pendiente
  Sprint D, requiere refactor de design tokens)

## Patrones de código

### Parseo defensivo de jsonb

Todo consumo de `tenants.config.*` debe pasar por un hook con
defaults explícitos. Ejemplos:

- `useLandingConfig` → bloque landing + contacto
- `parseBeneficios` (en Landing.tsx + Tiers.tsx) → arrays string

Los defaults del hook son **strings vacíos** (no textos EKKO
específicos). El kernel no debe asumir nombre de cliente. Los textos
reales vienen de la migración SQL del tenant inicial.

### Schema-first con migraciones

Cada cambio de estructura va en una migración SQL. Los textos
default de un tenant vienen en la migración, NO en el hook.
El hook tiene defaults vacíos para que un tenant nuevo no rompa.

### Componentes desacoplados de identidad

Componentes como Footer NO deben hardcodear "EKKO" ni "Cravia".
Todo viene de `useTenant()` (nombre, slug) o `useLandingConfig()`.

## Pendientes para producto replicable

### Sprint C2 (próximo)

- FAQ editable (hoy 6 items hardcoded inline en Landing.tsx)
- Sección "Cómo funciona" editable (3 pasos hardcoded)
- Títulos de sección Estudios y Membresías editables
- Refactor AutoForm para mejor UX en bloques profundos (toggle
  para activar/limpiar campos nullable)

### Sprint D (alta prioridad)

- Logo upload + favicon dinámico
- Tabla `anuncios` para banners temporales por tenant
- Branding tokens dinámicos (refactor de design system)

### Sprint E (cuando aparezca cliente B real)

- Vocabulario configurable: `tenants.config.ui.etiqueta_recurso`
  permitiría rename "Estudio" → "Sala" / "Cabina" / "Espacio"
- Auditoría: ~30 lugares hardcoded en codebase
- Crítico para vender a yoga/pilates/podcast booths

### Sprint F (multi-página)

- Si se necesitan rutas separadas (/terminos, /privacidad),
  considerar tabla `tenant_pages` con slug + content jsonb
- Versionado / drafts / preview

## Anti-patrones (NO hacer)

1. **NO hardcodear "EKKO", "Cravia", "Culiacán"** en componentes.
   Todo viene del tenant config.

2. **NO hardcodear textos de UI** que vayan a variar por tenant.
   Si es contenido editable, va al jsonb.

3. **NO duplicar el WhatsApp.** Hay UN solo punto de verdad:
   `tenants.config.contacto.whatsapp_e164`. Consumido vía el
   helper `whatsappUrl()` del hook `useLandingConfig`.

4. **NO crear tablas nuevas para contenido editable.** El jsonb
   permite iteración rápida sin migraciones. Solo tablas para
   datos relacionales o transaccionales (anuncios, reservas).

5. **NO mezclar branding con config.** Branding son assets/colores
   visuales. Config son textos/reglas de negocio.

6. **NO leer `tenants.config` directamente** desde componentes —
   pasá por el hook correspondiente con parseo defensivo.

## Patrón Soft-Delete (Sprint C-CRUD)

### Filosofía
Todas las entidades de dominio (recursos, tiers, anuncios futuros)
usan soft delete vía campo `activo: boolean`. **NUNCA** hard delete.

### Razones
1. **Integridad referencial**: reservas históricas mantienen
   referencia al estudio donde ocurrieron, aunque el estudio
   ya no esté activo.
2. **Reversibilidad**: admin puede restaurar errores sin perder
   datos.
3. **Auditoría**: queda registro histórico de qué estuvo activo
   y cuándo.
4. **Stripe**: tier archivado con `stripe_price_id` no se borra;
   queda referencia para reportes pasados.

### Contrato de implementación
Toda entidad soft-deletable debe:
1. Tener columna `activo BOOLEAN NOT NULL DEFAULT true`.
2. Tener índice `(tenant_id, activo)` para performance.
3. Filtrar `WHERE activo = true` en TODAS las queries públicas
   (landing, member, signup).
4. Mostrar archivados solo en admin con toggle explícito.
5. Validar antes de archivar si hay dependencias activas
   (ej: tier con miembros activos via `countActiveMembersInTier`).
6. **NUNCA** copiar referencias externas únicas (Stripe IDs, etc.)
   al duplicar — son globalmente únicas en otro sistema.

### Patrón "Duplicar"
Helper `generateUniqueSlug(base, existingSlugs)` + omitir campos
auto-generados (id, created_at, stripe_*). Prefijo "(copia)" en
nombre para diferenciación visual inmediata.

### Tablas que aplican el patrón
- `recursos` (estudios)
- `tiers` (membresías)
- `anuncios` (futuro Sprint D)

### Tablas que NO aplican (datos transaccionales)
- `reservas` — cancelar es propio dominio (`status='cancelada'`),
  no soft-delete genérico.
- `payment_events` — eventos inmutables, nunca se archivan.
- `usuarios` — el equivalente es `status='suspendido'` o
  `'cancelado'`, no `activo` boolean.

### Helpers reusables
- `src/admin/lib/crudHelpers.ts`
  - `archiveRecord(table, id)`
  - `restoreRecord(table, id)`
  - `generateUniqueSlug(base, existing)`
  - `countActiveMembersInTier({tierId, tierSlug, tenantId})`

### Componente reusable
- `src/admin/components/ConfirmDialog.tsx`
  - Variants: `'danger' | 'warning' | 'info'`
  - `hideConfirm` para modo informativo bloqueante (ej: archivar
    tier con miembros activos)

## Patrón Admin Profesional (Sprint D-Admin)

### Filosofía
El admin de EKKO no es un form-builder genérico. Es producto diseñado
para dueños de negocio no técnicos. Cada pantalla responde a un caso
de uso real, no a un schema de BD.

### Estructura del sidebar
- **OPERACIÓN**: día a día (Dashboard, Miembros, Reservas)
- **CATÁLOGO**: productos vendibles (Estudios, Planes)
- **AJUSTES**: 4 páginas dedicadas (Landing, Contacto, Reglas, Marca)
- **VER COMO…**: previsualización del producto (4 links que abren
  en nueva pestaña)

### Reglas de UX
1. **Labels humanos siempre**: nunca mostrar nombres técnicos al
   admin. `whatsapp_e164` → "Número de WhatsApp".
2. **Helper text en cada campo crítico**: explicación corta + ejemplo
   cuando aplica.
3. **Bloques DEAD no se muestran**: si una config está sembrada en BD
   pero no consumida en producción, NO va en admin. Solo se muestra
   lo que afecta al producto real. La página `/admin/reglas` solo
   expone los 4 campos consumidos por el RPC.
4. **Feedback de cambios**: indicador "Sin cambios" / "Cambios sin
   guardar". Botón "Guardar" explícito. Toast al guardar.
5. **VER COMO**: admin puede previsualizar cualquier vista del producto
   sin perder su sesión. Demo guard sobre `?demo=admin-preview` (TODO
   Sprint Stripe).

## Patrón Soft + Hard Delete con Guards (Sprint D-Admin)

### Vocabulario
- **UI**: "Eliminar" (no "Archivar")
- **BD**: campo `activo: boolean` (soft delete) — sigue siendo soft
  delete internamente
- **Hard delete**: opción "Eliminar permanentemente" desde la papelera
  con typed confirmation ("ELIMINAR")

### Flow
1. **Click "Eliminar" en activo** → soft delete (`activo=false`) →
   confirma con dialog warning → toast "Se moverá a eliminados".
2. **Click "Recuperar" en eliminado** → `activo=true` → toast.
3. **Click "Eliminar permanente" en eliminado** → check FKs vía RPC
   → si OK, typed confirmation ("ELIMINAR") → DELETE FROM table.

### Guards
- **Recursos**: NO permitir hard delete si hay reservas vinculadas
  (cualquier estado).
- **Tiers**: NO permitir hard delete si hay miembros vinculados
  (activos o históricos, doble fuente: `membresias.tier_id` +
  `usuarios.membresia_tier`).
- Hard delete SOLO disponible desde sección "Eliminados".
- Hard delete SOLO con typed confirmation.

### Helpers
- `canHardDeleteRecurso(id)` → `{ canDelete, reason?, count? }`
- `canHardDeleteTier(id)` → idem
- `hardDeleteRecord(table, id)` — IRREVERSIBLE
- RPCs SQL: `count_reservas_recurso`, `count_miembros_tier`

## Hook reusable: useTenantConfigEditor (Sprint D-Admin)

### Propósito
Hook que abstrae el patrón de edición de bloques en `tenants.config`
jsonb. Usado por todas las páginas de AJUSTES (Landing, Contacto,
Reglas) y disponible para sprints futuros (Marca, FAQ, etc).

### API

```typescript
const { config, isLoading, isSaving, saveTopLevel, reload } = useTenantConfigEditor();
```

- `config`: snapshot completo del config (o null mientras carga).
- `isLoading`/`isSaving`: estados de fetch / mutation.
- `saveTopLevel(patch)`: hace `UPDATE tenants SET config = { ...config, ...patch }`.
  El merge es **shallow en top-level** — el caller es responsable de
  preservar sub-keys no modificadas.
- `reload()`: re-fetch desde BD (útil para descartar cambios).

### Merge no destructivo (responsabilidad del caller)

Como `saveTopLevel` solo hace merge shallow, cada página que edita un
sub-objeto anidado (ej. `landing.hero`) tiene que componer el patch
preservando otras keys del bloque:

```typescript
const landing = (config?.landing ?? {}) as Record<string, unknown>;
const patch = {
  landing: {
    ...landing,  // preserva cta_final, footer, etc.
    hero: nuevoHero
  }
};
await saveTopLevel(patch);
```

Este patrón es lo que protege los bloques DEAD sembrados en BD
(`config.ui`, `config.acceso`, etc.): nadie los toca, nadie los
borra, quedan a la espera de un sprint que los consuma o limpie.

### Aplicaciones actuales
- `AjustesLanding.tsx` — `config.landing.hero`, `cta_final`, `footer`
- `AjustesContacto.tsx` — `config.contacto`, `config.landing.footer.redes`
- `AjustesReglas.tsx` — `config.reserva`, `config.penalizaciones`

### Aplicaciones futuras
- `AjustesMarca.tsx` — `tenants.branding.logo_url`, `colors.*`
- Sprint C2 — `config.landing.faq`, `config.landing.como_funciona`

## VER COMO… + Demo Mode (Sprint D-Polish)

### Propósito
Permite al admin previsualizar el producto como lo vería cada tipo de
usuario, sin perder su sesión de admin.

### Vistas disponibles
- 🏠 **Landing**: vista pública (`/?demo=admin-preview`)
- 👤 **Miembro**: app del miembro (`/app?demo=admin-preview`)
- 📋 **Recepción**: panel de check-in (`/recepcion?demo=admin-preview`)

Signup excluido: el admin ya lo ve en flow normal cuando un visitante
hace click en una membresía desde Landing.

### Flow técnico
1. Click VER COMO en sidebar admin → `window.open(url, '_blank')`.
2. Nueva pestaña carga la ruta con `?demo=admin-preview`.
3. `useRoleRedirect` detecta el parámetro y **bypassea** el redirect
   automático a `/admin` que normalmente dispararía con un admin
   logueado.
4. `DemoBanner` se renderiza sticky-top con "Volver al admin →".
5. Click "Volver al admin": `window.close()` con fallback a redirect
   a `/admin/landing` después de 100ms (cubre el caso de pestañas
   abiertas manualmente que el navegador no deja cerrar por script).

### Dónde se monta DemoBanner
- `PublicLayout.tsx` (vista Landing)
- `MemberLayout.tsx` (vista Miembro)
- `ReceptionLayout.tsx` (vista Recepción)

### Seguridad (pendiente)
Hoy el demo mode NO tiene guard estricto: cualquiera con la URL puede
ver las vistas, pero solo si tiene sesión válida del rol correspondiente
(el guard de auth sigue activo). Riesgo bajo. TODO Sprint Stripe:
- Validar admin via JWT custom claim en Edge Function
- Logging server-side de cada uso de demo mode

## Sistema de Toasts (Sprint D-Admin)

`ToastProvider` global en root. Hook `useToast()` expone 4 métodos:
`success`, `error`, `warning`, `info`. Stack vertical en esquina
bottom-right con auto-dismiss + manual close.

**Reemplaza TODOS los `alert()`** del codebase. Cero `alert()` en src/
(verificado por grep).

## Separación Miembros vs Equipo (Sprint Equipo)

### Filosofía
El admin de EKKO separa dos tipos de usuarios:
1. **Miembros**: clientes pagadores. CRUD frecuente, bajo riesgo.
2. **Equipo**: staff con acceso al sistema (admins, recepcionistas).
   CRUD raro, alto riesgo (IAM).

### Por qué separados
- Diferentes casos de uso (gestionar clientes vs gestionar accesos).
- Diferentes acciones primarias ("+ Nuevo miembro" vs "+ Invitar persona").
- Diferentes validaciones (delete cliente vs revocar acceso).
- Mejor escalabilidad: un yoga studio puede tener 200 clientes + 5
  instructores; un restaurante puede tener 0 clientes + 12 empleados.

### URLs
- `/admin/miembros` → SOLO usuarios con `rol='miembro'`.
- `/admin/equipo` → admins + recepcionistas.

### Validaciones de seguridad
1. **No auto-modificación**: admin no puede revocar/cambiar su propio rol.
2. **Último admin protegido**: no se puede revocar al último admin del
   tenant. Mensaje claro de qué hacer ("invita o promueve a alguien
   antes").
3. **Soft-revoke**: `status='revocado'` (no hard delete). Preserva
   auditoría e historial de acciones. La persona no puede loguear pero
   su row queda en BD.

### Patrón "Crear acceso" (Sprint Fix Equipo)
- Admin crea usuario del equipo con email + password directos.
- Edge Function `create-team-member` (deployada en Supabase) usa
  `service_role` para crear el auth user + insertar en `usuarios`
  con `auth_id` real y `status='activo'`.
- Admin recibe modal de confirmación (`CredencialesCreadasModal`)
  con las credenciales formateadas y botón "Copiar".
- Comparte credenciales manualmente (WhatsApp, llamada).
- Si la persona pierde la password: "Olvidé mi contraseña" desde
  `/login` (flow nativo de Supabase Auth).

### Por qué NO email automático (todavía)
- Email automático requiere infra adicional (Resend o similar).
- Templates branded requieren Sprint Marca con logo.
- Realidad operativa de SMBs LATAM: admins prefieren WhatsApp.
- Si en el futuro se necesita email automático, agregar como
  opción adicional sin romper este flow simple.

### Estados del usuario del equipo
- `activo` + `invitado=false`: trabajando normalmente (default
  post Sprint Fix Equipo).
- `revocado`: ya no puede loguear, datos preservados.
- `suspendido`: temporal (futuro, no implementado aún).
- `pendiente_onboarding` + `invitado=true`: **LEGACY** del Sprint
  Equipo original. Ya no se crea con este estado; queda la columna
  en BD por compatibilidad y para reuso futuro (email automático
  opt-in).

### Roles soportados (Sprint Equipo)
- `admin`: acceso total
- `recepcionista`: acceso operativo (check-in, reservas, lectura)

Roles futuros (no implementados):
- `contador`: solo finanzas/reportes
- `marketing`: solo landing + anuncios
- Permisos granulares: opt-in checkboxes en lugar de roles fijos

### Helpers
- `countAdminsActivos(tenantId)` → number — RPC backend
- `canModifyTeamMember({...})` → { canModify, reason? } — front-end gate
- `revokeTeamMember(userId)` → soft-revoke (status='revocado')

## Dashboard relevante (Sprint Final)

### Filosofía
NUNCA agregar métricas que no respondan una pregunta accionable.
Métricas deshabilitadas elegantemente cuando faltan integraciones
(mostrar "—" + CTA "Conecta Stripe", no $0). Comparativos siempre
que haya data; "Primer mes 🎉" como fallback.

### 3 secciones máximo
- **HOY**: operación inmediata (próximas reservas + cancelar)
- **TU MES**: tendencia (3 métricas con flecha ↑/↓ + gráfica 30 días)
- **DINERO**: cuando aplica (deshabilitado hasta Stripe)

### NO agregar
- Top estudios, top tiers, MRR, churn, ocupación absoluta sin contexto,
  cobros pendientes (modelo de contado), alertas genéricas inventadas.

## Cancelación de reservas (Sprint Final)

### Vocabulario
- UI: "Cancelar reserva" (no "Eliminar reserva").
- BD: `status='cancelada_admin'` (distinguible de `cancelada` que es
  acción del miembro).
- Helper: `cancelarReserva({ reservaId, motivo, canceladoPorId, notificarMiembro })`.

### Flow
1. Admin abre modal con info de reserva (no editable).
2. Motivo obligatorio (mínimo 5 chars, se comparte con el miembro).
3. Checkbox "Notificar al miembro" (default: true).
4. Sugerencia WhatsApp pre-formateada con el motivo escrito en
   tiempo real + botón "Copiar mensaje".
5. Typed confirmation "CANCELAR".
6. UPDATE reservas + INSERT notificaciones (in-app inbox).
7. Toast success + refetch.

### Notificaciones in-app
- Tabla `notificaciones` con `usuario_id`, `tipo`, `titulo`, `mensaje`,
  `leida`, `metadata`.
- Banner sticky-top mostaza en `MemberLayout` que renderiza las no
  leídas (hasta 5). Botón ✕ marca como leída individualmente.
- RLS: usuario solo lee/marca las suyas; admin del tenant inserta.
- Email/SMS: pendiente Sprint Resend.

## Branding (Sprint Final · slim)

### Schema
`tenants.branding` jsonb con keys:
- `logo_url_dark` — logo principal (header oscuro, sidebar admin, footer)
- `og_image_url` — imagen Open Graph para redes
- `favicon_url` — favicon dinámico

### Upload
Bucket público `logos` con policies: SELECT anon, INSERT/UPDATE/DELETE
solo admin. Path: `{tenant_slug}/{nombre-asset}-{timestamp}.{ext}`.
Reusa el componente `ImageUploader` existente.

### Consumo
- `Sidebar.tsx` (admin) renderiza `<img logoUrl>` si existe, sino
  fallback a texto `tenant.nombre.split()[0]`.
- `Footer.tsx` (público) mismo patrón.
- OG image y favicon dinámicos via meta tags: **pendiente** hooks
  `useOGTags` y `useFavicon` (Sprint posterior con Marca completa).

## Filtros de status de reserva (Sprint M1)

### Source of truth
`src/shared/constants/reservaStatus.ts` exporta los conjuntos canónicos.
Cualquier filtro de UI sobre `reservas.status` debe consumirlos —
nunca hardcodear arrays inline.

```ts
ESTADOS_RESERVA_ACTIVOS    = ['confirmada']
ESTADOS_RESERVA_HISTORICOS = ['completada','no_show','cancelada','cancelada_admin']
ESTADOS_RESERVA_CANCELADAS = ['cancelada','cancelada_admin']
```

### Reglas de visibilidad
- **Dashboard / próxima sesión / próximas reservas**: SOLO `confirmada`
  (filtro estricto + `slot_inicio > now`).
- **Perfil / historial**: los 4 estados de `ESTADOS_RESERVA_HISTORICOS`.
  Badge diferenciado para `cancelada` (neutral, "La cancelaste") vs
  `cancelada_admin` (danger, "Cancelada por administración"). Si hay
  `cancelada_motivo`, se muestra inline.
- **qr-issue Edge Function**: solo emite QR si `status === 'confirmada'`.
  Cualquier otro retorna `400` con mensaje específico que el frontend
  traduce a copy human-friendly (`traducirErrorQR` en MiQR.tsx).

## QR de check-in (Sprint M1)

`qr-issue` aplica las siguientes validaciones (defensa profundidad
encima de RLS):

1. **Auth**: Bearer JWT del usuario autenticado.
2. **Ownership**: `reserva.usuario_id === usuario_actual.id`. RLS ya
   filtra, pero validamos explícito por si el client tiene service_role
   leak en el futuro.
3. **Tenant**: `reserva.tenant_id === usuario_actual.tenant_id`.
4. **Status whitelist**: solo `confirmada`.
5. **Ventana temporal**: ±7 días alrededor de `slot_inicio`.

Cualquier validación que falle retorna `400` o `401` con mensaje
descriptivo. El frontend (`MiQR.tsx`) tiene `traducirErrorQR` que
mapea esos mensajes a copy para el miembro.

## Cancelación de reservas por miembro (Sprint M2)

Cierra el gap del audit: el helper `cancelarReserva` existía en
`src/member/hooks/useReservas.ts` pero ninguna UI lo invocaba —
miembros llamaban a recepción para cancelar. Ahora pueden hacerlo
desde el Dashboard.

### Distinción clave vs admin
- **Miembro cancela su propia reserva** → status final `cancelada`,
  modal `CancelarMiReservaModal` (chips + textarea, 2 pasos
  info → confirm, sin typed-confirmation).
- **Admin cancela reserva ajena** → status final `cancelada_admin`,
  modal `CancelarReservaModal` (typed "CANCELAR", checkbox notificar,
  sugerencia WhatsApp). Sigue **intacto**.

### Componentes
- `src/member/hooks/useReglaCancelacion.ts` — lee
  `tenant.config.reserva.cancelacion_min_horas_antes` (jsonb pattern).
  Default `0` si no está configurada (permisivo). Helper puro
  `puedeCancelarReserva(slotInicio, minHorasAntes)` devuelve
  `{ puede, razon?, horasRestantes }`.
- `src/member/components/CancelarMiReservaModal.tsx` — modal de 2 pasos
  con chips de sugerencia (`['Cambio de planes','Salud','Trabajo','Otro']`)
  + textarea de motivo (opcional, ≤ 280 chars). Llama al helper
  existente `cancelarReserva` del miembro.
- `src/member/components/BotonCancelarReserva.tsx` — wrapper que
  encapsula la lógica "puede / no puede". Si no puede, muestra
  razón + link WhatsApp con mensaje pre-formateado (sólo si
  `tenant.config.contacto.whatsapp_e164` existe).

### Backend
- Reusa RPC `cancelar_reserva_atomic(p_reserva_id, p_motivo)` que ya
  valida ownership (usuario_id o admin), status `confirmada` y
  `slot_inicio > now()`. La regla de horas mínimas es **client-side**
  (UX); el RPC sólo bloquea reservas pasadas.
- No se modifica el schema. Sólo se usan campos existentes:
  `status`, `cancelada_at`, `cancelada_motivo`.

### Wiring
Dashboard hero (`src/member/pages/Dashboard.tsx`) renderiza
`<BotonCancelarReserva>` debajo del botón "Ver QR" cuando hay
próxima reserva. `onCancelada` dispara `refetch` de
`useProximasReservas`, que des-monta el hero al instante.

## Recepción — Operación (Sprint R1)

### statusConfig completo
`src/reception/components/ReservasHoyView.tsx` mapea TODOS los status
posibles (confirmada, completada, cancelada, **cancelada_admin**, no_show).
`cancelada` y `cancelada_admin` comparten visual: recepcionista no
diferencia quién canceló (info irrelevante para operación). Cualquier
status no mapeado renderiza un badge `⚠️` visible — mejor que fallar
silencioso a un default "PENDIENTE" engañoso.

Cada entry tiene `bloqueaCheckIn: boolean`. Cards con `bloqueaCheckIn=true`
están `disabled` y no abren el modal de check-in manual. El backend
(`check_in_atomic` RPC) también valida — esto es defensa UI.

### Búsqueda + filtro por recurso
- Input search con debounce **200 ms**. Filtra in-memory por nombre,
  email y folio del miembro. Helper `normalizar()` ignora acentos
  ("Jose" matchea "José").
- Dropdown "Todos los estudios" + lista de recursos activos del tenant.
  Persistido en `localStorage` con key `ekko-recepcion-filtro-recurso`
  (recepcionista suele filtrar el mismo estudio todo el día).
- Filtros combinables. Pills clickeables abajo del input muestran qué
  está activo; click en pill quita ese filtro específico.
- Empty state propio cuando filtros no devuelven resultados (CTA
  "Limpiar filtros").

### Feedback sonoro + táctil
`src/reception/lib/checkInFeedback.ts` expone `playCheckInSuccess()` y
`playCheckInError()`. Sin dependencias nuevas:

- **Success**: beep 880 Hz / 200 ms (Web Audio API) + vibración 100 ms.
- **Error**: beep 220 Hz / 400 ms + vibración patrón `[100, 50, 100]`.
- Falla silenciosamente si `AudioContext` o `navigator.vibrate` no están
  disponibles. iOS Safari no soporta vibrate — el beep sí funciona si el
  recepcionista no muteó el dispositivo.

Invocado desde:
- `CheckInDetail` (1 vez por mount, según `kind === 'success' | 'error'`)
  para el flow de QR scanner.
- `ManualCheckInModal.handleConfirm` (success + error) para el flow
  manual.

### Mobile safe-area
FAB del Scanner usa `bottom: calc(24px + env(safe-area-inset-bottom, 0px))`
para no taparse con el home indicator en iPhone con notch. Mismo patrón
en `.rec-hoy` paddingBottom (110px + safe-area). `index.html` ya tiene
`viewport-fit=cover` en el meta viewport.

## UX polish miembro (Sprint M3)

Cierra inconsistencias detectadas en auditoría: toasts/errores
desigual entre admin y miembro, notificaciones sin polling, QR no
responsive, copy burocrático, loading states mezclados.

### Toasts estandarizados
- TODO el módulo miembro consume `useToast()` (mismo patrón que admin).
- ELIMINADO: `setError` local con JSX condicional, `console.error`
  como UX silenciosa. Conservamos `console.error` para debugging
  cuando el fallo es no-bloqueante, **pero siempre acompañado de**
  `toast.warning(...)` para enterar al miembro.
- Mensajes warm y human, nunca técnicos:
  - "No pudimos cargar los estudios · Intentá refrescar"
  - "Reserva confirmada · lunes 19 de mayo, 09:00"
  - "Tu reserva fue cancelada"

### Polling de notificaciones in-app
`src/shared/hooks/useNotificacionesMiembro.ts` ahora hace polling
cada **30 s** con pausa cuando la tab está inactiva
(`visibilitychange` API). Al volver a la tab, refetch inmediato +
reanuda el interval. Errores del polling se loguean en silencio
(no spamean al miembro). 30 s elegido por consistencia con el
patrón de recepción.

### QR responsive + estados
- Wrapper `maxWidth: 24rem` centrado, contenedor con
  `aspectRatio: '1 / 1'` para mantener proporción cuadrada en mobile.
- `<QRSkeleton>` con `.ek-skeleton` (shimmer) mientras el backend
  emite el payload.
- `<QRError>` muestra mensaje human (vía `traducirErrorQR`) + CTA
  **"Reintentar →"**. Reintentar usa un `retryTick` como dep del
  efecto de fetch.

### Copy de cancelación
- "Cancelada por administración" → **"Cancelada por el estudio"**.
- "para {fecha}" → **"del {fecha}"** (más natural en español).
- Label en historial miembro: `CANCELADA · EKKO` → `CANCELADA · ESTUDIO`.
- Mensaje hardcodeado de `notificaciones` en
  `src/admin/lib/crudHelpers.ts:cancelarReserva` también actualizado.

### Loading states
Patrón unificado vía clase `.ek-skeleton` (ya existía con shimmer).
Reemplaza los `<p>Cargando...</p>` en `Reservar.tsx` (selector de
recursos + grid de slots). `Estudios.tsx` y `EstudioDetalle.tsx` ya
usaban skeleton; `MiQR.tsx` ahora también.

### Tests
`useNotificacionesMiembro.test.tsx` cubre 4 casos del polling:
refetch inicial, polling cada 30 s mientras visible, pausa al ocultar
tab, refetch + reanuda al volver. Fake timers + `vi.hoisted` para
mantener referencia estable de `usuario` (evita re-mount en cada
re-render).

## Mobile-first — bloqueantes (Sprint MA1)

Cierra los 5 issues más graves del [MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md)
(48 findings, grade C-). Desbloquea el uso del sistema en iPhone
antes del QA de Cravia.

### Admin Calendario — 3 vistas (Día / Semana / Lista)
- **Día** (default mobile <768px): 1 columna, reservas del día
  ordenadas por hora, scroll vertical. `VistaDia` en
  `src/admin/components/calendario/VistaDia.tsx` — fetchea su propio
  día vía `useReservasRango`.
- **Semana** (default desktop ≥768px): el grid de 7 columnas. En
  mobile se oculta (`.adm-cal-semana-desktop` / `.adm-cal-semana-hint`
  vía media query) con un hint que sugiere cambiar a Día. Las 7
  columnas a 375px quedaban en ~49px c/u — ilegibles.
- **Lista**: `ReservasVistaLista` (Sprint 8), sin cambios.
- Default por viewport + persistencia en
  `localStorage('ekko-admin-reservas-vista')`. Lógica aislada en
  `src/admin/lib/calendarioVista.ts` (`readVista`) para testeo.
  Valor legacy `'calendario'` migra al default por viewport.

### Touch targets ≥44×44 (Apple HIG)
- `CardMenuDropdown`: trigger ⋯ pasó de 32×32 a 44×44; items del
  menú con `minHeight: 44px`. El fix se propaga a Recursos, Equipo,
  Tiers, MiembroDetalle, Cobranza (componente compartido).
- Toggle de vistas del calendario: `minHeight: 44px` por botón.
- Botones de navegación de día (← →): 44×44.

### Keyboard-aware forms (iOS)
- `Signup`: `100vh → 100dvh`, `paddingBottom` con `env(safe-area-inset-bottom)`,
  y `scroll-into-view` al enfocar inputs (handler en el `<form>`,
  focus burbujea en React).
- `Login`: eliminado `alignItems: center` que empujaba el CTA detrás
  del teclado → `flex-start` + `paddingTop` clamp.

### Pause-on-blur polling
- `useReservasHoy` (recepción) ahora pausa el polling de 30s cuando
  la tab está oculta y hace refetch al volver. Mismo patrón que
  `useNotificacionesMiembro` (M3). Ahorra batería del iPad.

### Reservar slot grid
- Grid de slots pasó de `repeat(auto-fit, minmax(72px, 1fr))` (3
  columnas cortadas a 375px) a `repeat(4, 1fr)` (4 columnas
  garantizadas, ~85px c/u). Slots ya tenían `minHeight: 52px`.

### Tests
- `calendarioVista.test.ts` — 8 casos de `readVista` (preferencia
  guardada, default por viewport, breakpoint exacto, migración de
  valor legacy).
- `useReservasHoy.test.tsx` — 4 casos del polling visibility-aware
  (mismo patrón de fake timers que M3).

## Mobile-first — HIGH priority (Sprint MA2)

Continúa MA1: cierra el CRITICAL restante + 7 HIGH del
[MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md). No se tocaron
MEDIUM ni LOW (quedan para MA3/MA4).

### Safe-area en el drawer admin
- `.adm-drawer` aplica `padding-top` / `padding-left` con
  `env(safe-area-inset-*)` para no esconder el sidebar bajo el
  notch / Dynamic Island.
- Botón de cerrar del drawer: 36×36 → 44×44, posicionado con
  `max(16px, env(safe-area-inset-top/right))`.

### Touch targets ≥44×44 (continuación)
- Hamburger del topbar admin: 40×40 → 44×44 (+ spacer simétrico).
- `BotonCancelarReserva` (miembro): `minHeight: 44px` + flex
  centrado — conserva el aspecto de link de texto, solo agranda
  el área tapeable.
- `NotificacionesBanner` ✕: 16×16 → 44×44 con márgenes negativos
  para no inflar visualmente el banner.
- `EstudioModal` (público) ✕: 36×36 → 44×44 + safe-area.

### `.adm-form-row` apila en mobile
- `@media (max-width: 600px)`: `flex-direction: column` +
  labels full-width. Antes dependía de `flex-wrap` (squish en
  viewports intermedios).

### ReservasVistaLista — scroll horizontal + columna sticky
- El contenedor tenía `overflow: hidden` → **clipaba** la tabla
  de 7 columnas en mobile (no scrolleaba). Ahora `overflow-x: auto`.
- Grid de header y filas con `min-width: 760px` para no aplastar
  columnas.
- Columna **Fecha** con `position: sticky; left: 0` — el contexto
  temporal queda fijo al scrollear horizontal. Decisión del
  reporte (§5.2): mantener tabla, NO convertir a cards.

### Hook compartido `useVisibilityAwarePolling`
- `src/shared/hooks/useVisibilityAwarePolling.ts` — extrae la
  lógica de polling visibility-aware que estaba duplicada en
  `useNotificacionesMiembro` (M3) y `useReservasHoy` (MA1).
- API: `useVisibilityAwarePolling(poll, intervalMs, enabled?)`.
  `poll` debe ser estable (`useCallback`); cuando su identidad
  cambia, re-ejecuta (refetch inmediato + reinicia interval).
  `enabled=false` gatea todo (ej. sin usuario).
- Ambos hooks refactorizados sin cambio de comportamiento — los
  tests de integración previos (`useReservasHoy.test.tsx`,
  `useNotificacionesMiembro.test.tsx`) siguen verdes.

### Tests
- `useVisibilityAwarePolling.test.tsx` — 6 casos (montaje, polling,
  pausa, reanudación, `enabled=false`, montaje con tab oculta).

## Recepción polish (Sprint R2)

Cierra los MEDIUM operativos de recepción del
[MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md) §1.2 — deja el
módulo completo y profesional para el QA con Magaly.

### Loading
- `ReservasHoyView` muestra 8 skeletons (`.ek-skeleton`) durante el
  fetch inicial en vez de pantalla con texto "Cargando…". El
  day-nav + búsqueda + filtros quedan visibles mientras carga.

### CameraModal
- Botón cerrar: `top: -56px` (podía quedar bajo el notch / fuera de
  pantalla) → overlay en la esquina con
  `calc(12px + env(safe-area-inset-top/right))` + backdrop blur.
- Si la cámara falla / se rechaza el permiso: la vista de error
  ahora ofrece **Reintentar** (re-pide acceso vía `retryTick`) y
  **Usar check-in manual** (cierra la cámara → recepcionista busca
  por nombre). Antes quedaba sin salida.

### CheckInDetail
- `.rec-detail` añade `padding-left/right: max(32px, env(safe-area-inset-*))`
  — protege contra el notch lateral en iPad landscape sin reducir
  el padding de 32px en portrait.

### Touch targets ≥44×44
- Search clear ✕: 28×28 → 44×44 (input `paddingRight` ajustado).
- Pills de filtros activos: `minHeight: 44px`. El pill completo es
  el target (no se puede anidar `<button>` dentro de `<button>`).

### Contraste de status badges (WCAG AA)
- `completada` / `cancelada` / `no_show` usaban bg `*-soft`
  (alpha 0.12) + texto del mismo color → chip casi invisible.
  Ahora bg sólido saturado + texto `var(--ek-bg)` oscuro (≥4.5:1).
  `confirmada` ya era sólido (mustard + texto oscuro), sin cambios.

### Polling pausado durante modales de check-in
- `useReservasHoy(fecha, pollingEnabled)` — segundo parámetro
  threadeado a `useVisibilityAwarePolling`. `ReservasHoyView` pausa
  el polling cuando hay un modal abierto (manual local `selected`,
  o `CheckInDetail`/cámara a nivel Scanner vía prop `pausarPolling`).
  Evita que un refetch reordene la lista mientras la recepcionista
  revisa un check-in. Al cerrar el modal: refetch inmediato.

### Tests
- `useReservasHoy.test.tsx` — +2 casos: `pollingEnabled=false` no
  hace fetch; reanuda al pasar a `true`.
- `CameraModal.test.tsx` — 3 casos: vista de error con retry +
  salida manual; "Reintentar" re-pide cámara; "Usar check-in
  manual" cierra.

## Auth hardening (Sprint S1)

Endurece la puerta de entrada antes del QA con usuarios reales.

### Status check antes del redirect
- **Bug que cierra:** login OK → flash de `/app` → `MemberLayout`
  deslogueaba con toast → rebote a `/login`. La validación de status
  ocurría POST-redirect.
- **Fix:** `Login.tsx` trae el perfil (`rol, status`) y valida
  **antes** de cualquier redirect. Si el status no permite entrar:
  `signOut()` + mensaje claro, sin redirect. Si permite: navega
  directo según rol (`/admin` · `/recepcion` · `/app`), sin saltos
  intermedios por `useRoleRedirect`.

### `validarStatusCuenta` — fuente única de verdad
- `src/shared/lib/validarStatusCuenta.ts` — un mensaje claro por
  estado. Estados reales del enum: `pendiente_onboarding`,
  `pendiente_pago`, `activo`, `suspendido`, `cancelado`. Maneja
  `revocado` defensivamente (lo usa código admin pero no está en el
  CHECK) y cualquier status desconocido → bloquea + loguea.
- **NO valida `bloqueado_hasta`.** Es penalización de no-show
  (restricción de RESERVA, no de login): el miembro bloqueado puede
  entrar y ver el banner "RESTRICCIÓN ACTIVA" del Dashboard.

### `traducirErrorAuth`
- Traduce errores de Supabase Auth a copy human (credenciales,
  email no confirmado, rate limit, red). Fallback genérico que
  **nunca expone el mensaje técnico crudo**.

### MemberLayout guard
- Sigue como defensa profunda (sesión vieja cuyo status cambió
  mientras el miembro estaba dentro). Reusa `validarStatusCuenta`;
  al expulsar, redirige a `/login` con `state.mensaje`. `Login`
  lee ese state y muestra el mensaje (no deslogueo silencioso).

### Signup
- Validaciones: nombre ≥2 chars, email con regex + lowercase/trim,
  password ≥8 (antes 6), confirmación. Email duplicado → mensaje
  claro sugiriendo iniciar sesión.
- El mock de tarjeta (sin Luhn) se mantiene — el pago real llega
  con Stripe.

### Tests
- `validarStatusCuenta.test.ts` — 14 casos (un estado por case,
  status desconocido, `bloqueado_hasta` ignorado; errores de auth
  traducidos + fallback que no filtra el mensaje crudo).

## Mobile MEDIUM polish — Member (Sprint MA3-Member)

Cierra los 5 MEDIUM + 3 LOW del módulo miembro
([MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md) §1.1). Sube
Member de C+ a B+. Polish, sin bloqueantes.

- **Reservar — fecha selector:** wrapper `.ek-hscroll-fade` con un
  `::after` de gradiente en el borde derecho que insinúa "hay más
  fechas". `scroll-snap` x-proximity en el carril.
- **CancelarMiReservaModal:** chips de motivo `minHeight: 40px`
  (eran ~20px); padding del modal `clamp(16px, 5vw, 28px)` para no
  quedar apretado en 375px.
- **Dashboard + Estudios grids:** `minmax(180px/240px, 1fr)` →
  `minmax(min(100%, 160px), 1fr)` — comportamiento consistente
  entre iPhone SE (375px) y Pro (390px); el `min(100%, …)` evita
  overflow cuando el viewport es más chico que el mínimo.
- **Perfil — info grid:** clase `.perfil-info-grid` que en
  `@media ≤480px` vuelve las celdas filas (label izquierda, valor
  derecha). No toca el `.adm-info-grid` de admin.
- **LOW:** botones invitados +/− 40→44px; `MiQR` con
  `maxWidth: min(24rem, 100%)`; slots disabled ya estaban en
  `opacity 0.4` + color tenue (el finding apuntaba a una línea
  equivocada).

## Mobile MEDIUM polish — Admin (Sprint MA3-Admin)

Cierra los MEDIUM del módulo admin
([MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md) §1.3). Sube Admin
de D a B. Polish, sin bloqueantes.

- **.adm-modal:** `padding: clamp(16px, 4vw, 24px)` — en 375px ya no
  queda cramped (usado en NuevaPersonaModal, Recursos, Tiers).
- **ConfirmDialog:** título con `overflowWrap: break-word` +
  `fontSize: clamp(1rem, 4vw, 1.25rem)` — títulos largos wrappean.
- **.adm-sidebar-item:** `min-height: 44px` (era ~34px) — tap
  target cómodo en el drawer mobile, sigue OK en desktop.
- **DetalleReservaModal:** la fila de acciones usa `.adm-modal-actions`
  — en `@media ≤480px` apila los botones vertical full-width.
- **AdminDashboard MetricaCards:** clase `.adm-metricas-grid` —
  2 columnas en mobile (compactas), `auto-fit` desde 720px. Antes
  el `minmax(180px)` daba 1 sola columna en 375px.

Verificado ya-resuelto / no-issue:
- Sidebar drawer safe-area-top → cerrado en MA2 (CRITICAL #3).
- Topbar mobile → no estaba "crowded": es solo hamburger + marca
  "EKKO ADMIN" + spacer, sin page title. Sin cambio.

## Mobile MEDIUM polish — Public (Sprint MA3-Public)

Cierra los MEDIUM del módulo public
([MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md) §1.4). Sube Public
de D+ a B. Polish + conversión.

- **Touch targets 44px:** nav buttons de `PublicLayout` (incl.
  "Salir"), íconos sociales del `Footer` (36→44), y los links de
  contacto/navegación del footer (`minHeight: 44px` + inline-flex).
  El ícono visual sigue siendo ~18-20px, solo crece el área tapeable.
- **Hero CTA:** `padding 16px 32px` + `minHeight: 52px` +
  `inline-flex` centrado — CTA principal cómodo de tapear.
- **Landing — cards de estudios:** `loading="lazy"` +
  `decoding="async"` en las fotos (están below the fold; el hero no
  tiene imagen, así que no hay riesgo de LCP).
- **Signup — plan resumen sticky:** `position: sticky` con
  `top: env(safe-area-inset-top)` — el usuario sigue viendo qué
  compra al scrollear el form con el teclado abierto. Coexiste con
  el layout keyboard-aware de MA1/S1.

Verificado ya-resuelto / no-issue:
- EstudioModal safe-area: es un modal **centrado** (no fullscreen);
  el close button ya quedó safe-area en MA2. Sin cambio.
- Login keyboard-aware: ya resuelto en S1 (`100dvh` + `flex-start`).

## MA3-Reception (#9) + MA3 COMPLETO

- **ManualCheckInModal:** `.rec-modal` con
  `padding-left/right: max(24px, env(safe-area-inset-*))` —
  protege el notch lateral en iPad landscape sin regresar el
  padding portrait. Mismo patrón que `.rec-detail` (R2).
- **MA3 cerrado:** los 24 MEDIUM del [MOBILE_AUDIT_REPORT.md](MOBILE_AUDIT_REPORT.md)
  resueltos. Sumado a MA1/MA2/R2, los 3 CRITICAL + 10 HIGH + 24
  MEDIUM están cerrados. Los 4 módulos en grade B o mejor
  (Member B+, Admin B, Reception B, Public B).

## Mobile LOW polish (Sprint MA4) — AUDIT COMPLETO

Último tramo del audit: los 11 LOW (polish cosmético — touch targets
menores, padding, contraste, gradientes). Solo CSS/visual.

- **Reception:** "Limpiar filtros" del empty state → `minHeight: 44px`;
  `.rec-main` con padding L/R `max(24px, env(safe-area-inset-*))`; gap
  entre botones del modal de check-in 8→12px; day-nav arrows 40→44px.
- **Admin:** header de Miembros con `flex-wrap` + gap (title y CTA ya no
  se pisan); `HorariosEditor` con clase `.adm-horario-row` + media query
  (≤560px apila a 2 columnas — los inputs de hora dejan de quedar
  squish; desktop intacto); `SectionToggle` del sidebar `minHeight: 44px`.
- **Public:** hero gradient `right: clamp(-200px, -25vw, -80px)` (no
  desperdicia el glow en pantallas chicas); `EstudioModal` padding del
  cuerpo `clamp(16px, 5vw, 32px)`; footer links de contacto/navegación a
  `--ek-ink` → contraste **AAA** (≈17:1) sobre el fondo oscuro.
- Los LOW de Member ya se habían resuelto en MA3-Member.
- Deuda: los LOW son CSS/visual → sin tests automatizados (declarado).

**Auditoría mobile COMPLETA: 48 findings cerrados** (3 CRITICAL + 10
HIGH + 24 MEDIUM + 11 LOW). Los 4 módulos en grade B/B+.

## Recepción Plus — Backend (Sprint RP-1)

Eleva el rol `recepcionista` con capacidades de cara al cliente. Este
sprint es **solo backend** (RPCs + función + gate de rol + tests); la
UI llega en RP-2/3/4. Plan completo en
[RECEPCION_PLUS_PLAN.md](RECEPCION_PLUS_PLAN.md).

Todo es **aditivo** — ninguna policy de admin se relajó.

### Piezas nuevas
- **`reservar_para_miembro_atomic`** (RPC, migración
  `20260520100000`): recepción/admin reserva un recurso PARA un
  miembro objetivo. Gate de rol (`admin`/`recepcionista`), valida
  mismo tenant y `status='activo'` del miembro (D2). **Salta
  `min_anticipacion_horas`** para walk-ins de mostrador (D1).
  `bloqueado_hasta` (no-show) SÍ se sigue respetando.
- **`cancelar_reserva_atomic`** (RPC ampliado, `CREATE OR REPLACE`):
  recepción puede cancelar. Si la cancela un tercero (recepción/admin),
  `status='cancelada_admin'` + `cancelada_por` + notificación in-app
  "por el estudio" (D3). El miembro que cancela lo suyo sigue →
  `cancelada`. El RPC es `SECURITY DEFINER` → inserta en
  `notificaciones` sin chocar con la policy admin-only.
- **`reception-create-member`** (Netlify Function): recepción/admin
  registra miembros. `rol='miembro'` **hardcodeado** — el body no
  tiene campo `rol` y el código nunca lo lee → recepción jamás crea
  staff. `tenant_id` tomado del caller. `status='pendiente_pago'`.

### Lo prohibido sigue prohibido (sin tocar)
Staff (`admin-create-user`/`admin-delete-user` siguen exigiendo
`is_admin()`), `membresias`, `payment_events`, config, tenant y
hard-delete quedan detrás de `is_admin()`.

### Tests
- `src/__tests__/reception-create-member.test.ts` — 8 casos del gate
  de seguridad de la función (miembro → 403, `rol` del body ignorado,
  tenant del caller, etc.).
- `supabase/tests/rp1_security_checks.sql` — checklist runnable de los
  RPCs (validación manual con cuentas de prueba por rol; los RPCs
  dependen de `auth.uid()`, no hay infra pgTAP).

### Diferido
- **D4** (modelo de membresía → "reservas restantes" del perfil):
  no se tocó `membresias`. Se decide en RP-2.
- `status` del miembro creado por recepción quedó `pendiente_pago`
  (igual que `admin-create-user`). Si debe nacer `activo`, es una
  decisión a confirmar.

## Seguridad pre-launch (Sprint SEC-CLEANUP)

Limpieza de objetos de BD peligrosos o huérfanos antes del launch
de Cravia. Verificación previa: grep en el repo → 0 referencias
activas a los 3 objetos.

### Eliminados
- **`dev_crear_recepcionista`** — helper DEV que creaba
  recepcionistas sin cuenta de Auth (agujero si llegaba a prod).
  **Ya estaba dropeada** por la migración `20260514130000` (corre
  después de la que la crea). `20260520110000_sec_cleanup.sql`
  agrega un `DROP IF EXISTS` defensivo e idempotente — deja el repo
  explícito y cubre el caso de drift.
- **`generar_clases_recurrentes`** — RPC fantasma: vivía solo en la
  BD desplegada, nunca en el repo. Concepto "clases recurrentes" de
  SALA, no de EKKO; su última corrida dio `clases_creadas:0`. La
  migración la dropea con un bloque `DO` signature-agnóstico (no
  está versionada, no conocíamos su firma).
- **`create-team-member`** — Edge Function (Deno) fantasma. Ya no se
  llama desde el frontend (FIX01 la reemplazó por `admin-create-user`).
  **No se dropea por SQL** — se elimina del dashboard de Supabase
  (acción manual: `supabase functions delete create-team-member`).

### Deuda documentada
- El rol **`staff`** existe en el CHECK de `usuarios.rol`
  (`admin, recepcionista, staff, miembro`) pero no tiene semántica
  propia — es efectivamente igual a `miembro` para permisos (RLS,
  guards). Pendiente: correr `SELECT count(*) FROM usuarios WHERE
  rol='staff'`; si es 0, removerlo del CHECK en una migración
  futura es trivial y elimina un estado ambiguo.

### Resultado
El repo es la fuente de verdad de las funciones Postgres — no
quedan RPCs fuera de control de versiones. Tras eliminar la Edge
Function del dashboard, tampoco quedan objetos huérfanos.

## Recepción Plus — UI navegación + búsqueda + perfil (RP-2)

Primera capa de UI de Recepción Plus. Base sobre la que cuelgan
RP-3 (crear/cancelar/reprogramar) y RP-4 (registrar miembro).
Sin backend nuevo — recepción ya lee `usuarios`/`reservas` del
tenant vía RLS.

### Navegación de recepción
- `ReceptionLayout` ahora rinde el chrome compartido: header
  (marca + Salir) + **tabs superiores** (Check-in · Miembros).
  Tabs arriba, no bottom-nav: el Scanner tiene un FAB inferior.
- `Scanner` se refactorizó — soltó su header propio y el wrapper
  `rec-shell` (ahora los da el layout). Quedó solo con su
  contenido + FAB + modales.
- Rutas: `/recepcion` (Scanner), `/recepcion/miembros`
  (BuscarMiembro), `/recepcion/miembros/:id` (perfil). Todas bajo
  el guard de rol existente.

### Búsqueda de padrón
- `BuscarMiembro`: busca `usuarios` del tenant (`rol='miembro'`)
  por nombre o email con `ilike`. Debounce 200ms. Input sanitizado
  (se quitan `,%()_` que rompen `.or()` / son wildcards). Estados:
  inicial, loading (skeleton), vacío, resultados.

### Perfil read-only
- `PerfilMiembroRecepcion`: vista **NUEVA**, NO reusa
  `MiembroDetalle` de admin (riesgo R3 — ese edita status/rol/tier,
  resetea password, borra). Recepción solo consulta.
- Muestra: nombre, email, teléfono, plan, estado, inasistencias,
  alta, próximas reservas e historial. Estado de cuenta con alerta
  visible (recepción puede explicarle al cliente por qué su cuenta
  no está activa o está bloqueada por no-show).
- NO pide `stripe_customer_id` ni `ob_data` en el SELECT (riesgo
  R6). NO renderiza ningún control de edición.
- Marcador en el JSX donde RP-3 colgará las acciones de reserva.

### `staff` vs `miembro` en búsqueda
La búsqueda filtra `rol='miembro'` (el caso de uso es atender
clientes, no staff).

### D4 diferido
"Clases restantes" omitido — se asume membresía por tier
(ilimitada dentro del tier). Si Cravia confirma conteo, se agrega
leyendo `membresias` en un sprint posterior.

### Tests
- `miembroStatus.test.ts` — 4 casos del helper de estado.
- `PerfilMiembroRecepcion.test.tsx` — 3 casos, **de seguridad**:
  verifica que el perfil NO renderiza controles de edición
  (`select`/`input`/`textarea`/reset/eliminar/etc.) — atrapa
  cualquier regresión que meta edición en la vista de recepción.

## Recepción Plus — Crear + cancelar reserva (RP-3a)

Acciones de reserva desde el perfil de un miembro en recepción.
Consume los RPCs de RP-1 (ya aplicados).

### Crear reserva (walk-in)
- Botón "+ Crear reserva" en `PerfilMiembroRecepcion` → abre
  `CrearReservaModal` (recurso → fecha → slot → notas → confirmar).
- Reusa la lógica de slots del miembro (`reservaLogic`) — no se
  duplica. **D1:** el config se arma con `anticipacion_min_horas: 0`
  para que `generarSlotsDisponibles` no esconda los horarios
  cercanos (recepción reserva walk-ins).
- **D2:** el botón está `disabled` si el miembro no está `activo`,
  con mensaje claro. El RPC valida igual (defensa en backend).
- Llama `reservar_para_miembro_atomic` con `p_usuario_id` = id del
  miembro objetivo.

### Cancelar reserva
- Cada reserva en "próximas" del perfil tiene acción "Cancelar" →
  `CancelarReservaRecepcionModal` (confirmación + motivo opcional).
- **D3:** el RPC `cancelar_reserva_atomic` detecta que recepción ≠
  dueño → `status='cancelada_admin'` + `cancelada_por` + notifica al
  miembro. El front solo llama.

### Errores
- `traducirErrorReserva` (reception lib): traduce los códigos de
  los RPCs a mensajes claros. Cubre los nuevos de RP-1
  (`EKKO_MIEMBRO_*`) y delega los compartidos a `traducirErrorRPC`
  del módulo miembro. Fallback genérico — nunca expone el crudo.

### Modelo de cobro
Sin definir → crear reserva NO descuenta saldo (el RPC solo
registra acceso). Si termina siendo por créditos, se revisa.

### Tests
- `traducirErrorReserva` — 3 casos (códigos RP-1, delegación,
  fallback que no filtra el mensaje crudo).
- `CrearReservaModal` — wiring: confirma → `reservar_para_miembro_atomic`
  con `p_usuario_id` del miembro; error → toast traducido.
- `CancelarReservaRecepcionModal` — confirma → `cancelar_reserva_atomic`
  con el `reserva_id` correcto; error → toast, no cierra.
- `PerfilMiembroRecepcion` — D2 (botón disabled si no-activo). El
  test de seguridad de RP-2 sigue verde (las acciones de reserva no
  son edición de datos del miembro).

Pendiente: RP-3b (reprogramar) — ver más abajo.

## Recepción Plus — Registrar miembro (RP-4)

Registrar un miembro nuevo desde el mostrador. Consume la Netlify
Function `reception-create-member` (backend de RP-1) — RP-4 es solo UI.

- "+ Registrar miembro" en la pantalla de Miembros de recepción
  (`BuscarMiembro`): botón en el header + CTA en el estado "sin
  resultados" ("¿No lo encontrás? Registrá un miembro nuevo").
- `RegistrarMiembroModal` → `reception-create-member`. Modal de dos
  fases: (1) datos básicos, (2) credenciales para el cliente.
- Datos básicos: nombre, email, teléfono (opcional), password
  temporal autogenerada (alfabeto sin ambiguos, 12 chars; recepción
  puede regenerarla o escribirla). **NO** campo de rol (la función lo
  fija a 'miembro' — la UI tampoco lo expone, defensa en profundidad),
  **NO** tier (config), **NO** cobro (Stripe pendiente).
- Llama con `fetch` crudo, no `backendPost`: `backendPost` descarta el
  body del error y solo deja el status; se necesita `result.error`
  para traducir "email duplicado". NO se manda `rol` ni `tenant_id`.
- El miembro nace `pendiente_pago` → la vista de credenciales muestra
  un aviso explícito: "PENDIENTE DE ACTIVACIÓN — se activa al
  confirmar pago/plan con administración; mientras tanto no podrá
  reservar" (coherente con D2; registrar ≠ activar).
- Credenciales mostradas (nombre, email, password) con botón de
  copiar, para dárselas al cliente.
- Post-registro: al cerrar la vista de credenciales, el email queda
  pre-cargado en la búsqueda → el nuevo miembro aparece en resultados
  con badge `pendiente_pago`. El backend no devuelve el `id`, por eso
  no se navega directo al perfil.
- Errores: `traducirErrorRegistro` (reception lib) — email duplicado,
  password corta, permiso, sesión. Fallback genérico que tapa el
  `serverError` crudo de Supabase. Toast, no alert.

### Tests RP-4
- `traducirErrorRegistro` — 6 casos (duplicado y variantes, password,
  permiso, sesión, crudo→fallback sin filtrar, vacío).
- `RegistrarMiembroModal` — wiring (llama la función sin `rol`/
  `tenant_id`/`membresia_tier`, email normalizado, avanza a
  credenciales con el aviso de pendiente de activación), validaciones
  de form, email duplicado → toast traducido, y seguridad (el modal
  no expone ningún campo de rol).

## Recepción Plus — Reprogramar (RP-3b) — COMPLETO

Reprogramar una reserva próxima de un miembro a un nuevo horario/recurso,
desde el perfil de recepción.

- "Reprogramar" en cada reserva próxima del perfil (`PerfilMiembroRecepcion`,
  junto a "Cancelar"). **D2:** la acción se deshabilita si el miembro no
  está activo (crear la nueva reserva requiere miembro activo).
- Reusa `CrearReservaModal` (RP-3a) con la prop `reprogramarDe`: mismo
  flujo de selección (recurso → fecha → slot), con un encabezado de
  contexto "MOVIENDO ESTA RESERVA" y la reserva original excluida de la
  grilla (si no, su propio slot saldría 'ocupado' y los contiguos
  'continuo', y no se podría mover a ±1 slot).
- **D6: reprogramar = cancelar + crear, NO atómico.** Reusa los RPCs de
  RP-1 (`reservar_para_miembro_atomic` + `cancelar_reserva_atomic`).
  Orquestación en `reception/lib/reprogramarReserva.ts`.
- **Orden seguro híbrido** (`debeCancelarPrimero`): el RPC de crear
  rechaza `EKKO_CONTINUA` (hora contigua) y `EKKO_SLOT_OCUPADO` (solape
  mismo recurso). Mientras la vieja siga 'confirmada' puede disparar
  esos errores, así que:
  - Nuevo horario NO choca → **crear → cancelar** (si crear falla, la
    original queda intacta; el miembro nunca se queda sin reserva).
  - Nuevo horario SÍ choca (contiguo, o solape mismo recurso) →
    **cancelar → crear** (crear-primero fallaría por la propia vieja).
- **Fallos parciales SIEMPRE avisados** (nunca en silencio):
  - `parcial_sin_cancelar` — la nueva se creó pero la vieja no se
    canceló → toast pide cancelarla manual; el refresco la muestra.
  - `parcial_sin_recrear` — la vieja se canceló pero la nueva no se
    creó → toast avisa que el miembro quedó sin reserva.
- Tradeoff (D6): al no ser atómico, un fallo entre las dos operaciones
  deja estado parcial. Plan B documentado si molesta: RPC
  `reprogramar_reserva_atomic` (NO implementado — fuera de scope).
- Errores traducidos con `traducirErrorReserva` (RP-3a). Toast, no alert.

### Tests RP-3b
- `reprogramarReserva` — `debeCancelarPrimero` (contiguo, solape mismo
  recurso, solape distinto recurso, lejano) + orquestación: éxito
  crear→cancelar, fallo crear (no toca la vieja), `parcial_sin_cancelar`,
  éxito cancelar→crear, `parcial_sin_recrear`, fallo cancelar.
- `CrearReservaModal` — modo reprogramar: muestra el contexto y al
  confirmar orquesta los dos RPCs.
- `PerfilMiembroRecepcion` — D2: "Reprogramar" habilitada si activo,
  deshabilitada si no-activo.

**Recepción Plus COMPLETO:** buscar · perfil · crear · cancelar ·
reprogramar · registrar miembro.

## Fixes de seguridad (Sprint SEC-FIX)

Cierre de los 3 CRITICAL + 6 HIGH de [SECURITY_AUDIT.md](SECURITY_AUDIT.md)
antes del launch. Migración `20260521100000_sec_fix.sql` + cambios en 2
Netlify Functions.

- **C1 — `fake-signup`:** endpoint público sin auth que creaba cuentas
  `status='activo'` + `payment_event` falso. Ahora crea `pendiente_pago`
  (inerte — `reservar_recurso_atomic` exige `status='activo'`) y NO escribe
  payment_events. El registro sigue funcionando; la cuenta nace pendiente.
- **C2 — auto-elevación de rol:** RLS es row-level, no column-level → un
  miembro podía `UPDATE usuarios SET rol='admin'` en su propia fila.
  Trigger `BEFORE UPDATE` `trg_proteger_columnas_usuarios`: rechaza cambios
  a `rol/tenant_id/status/membresia_tier/no_shows_count/bloqueado_hasta`
  cuando el caller es un usuario logueado normal. La función es
  **`SECURITY INVOKER`** (no DEFINER) a propósito: distingue las vías por
  `current_user` — `'authenticated'` (ataque) vs `'service_role'` (Netlify)
  vs dueño de RPC SECURITY DEFINER. Con DEFINER, `current_user` sería el
  dueño del trigger y rompería los flujos de admin/service_role.
- **C3 — funciones dev:** `dev_activar_miembro` se escapó de SEC-CLEANUP.
  La migración dropea dinámicamente **toda** función `public.dev_*`.
- **H1 — columnas sensibles:** `ob_data` y `stripe_customer_id` salieron de
  `usuarios` a `usuarios_datos_privados` (RLS: dueño lee lo suyo, admin del
  tenant todo; recepción no entra). RLS no puede column-level y un GRANT de
  columnas no distingue admin de recepción (mismo rol Postgres). `SELECT *`
  sobre `usuarios` sigue funcionando → cero cambios de frontend.
- **H3 — `cancelar_reserva_atomic`:** ampliado en RP-1 sin validar tenant.
  Ahora, si la cancela un tercero (recepción/admin), exige que la reserva
  sea de su tenant (`EKKO_TENANT_DIFERENTE`).
- **H5 — `marcar_no_shows`:** estaba `GRANT ... TO authenticated`. Ahora
  solo `service_role`. La exposición HTTP de `cron-no-shows` (scheduled
  function) queda como verificación operativa de Netlify.
- **H2 — verificado:** `reservar_recurso_atomic` y
  `reservar_para_miembro_atomic` ya validan `status='activo'` en backend —
  la operación sensible (reservar) no se puede hacer suspendido. Sin código
  nuevo; test de regresión que fija el gate.
- **H4 — verificado:** ni `admin-create-user` ni `reception-create-member`
  loguean el password ni la respuesta. Se agregaron comentarios-guarda.
- **H6 — verificado:** `qr-issue`/`qr-verify` leen `QR_JWT_SECRET` de env
  var (no hardcodeado). El valor fuerte en prod es operativo.

Tests: `supabase/tests/sec_fix_checks.sql` (explotación: C2/C3/H1/H2/H3/H5
contra la BD) + `src/__tests__/fake-signup.test.ts` (C1). Los 8 MEDIUM +
6 LOW del audit quedan como hardening post-launch.

**SEC-FIX-2 — corrección del test, no del trigger.** Correr el test en vivo
mostró un ❌ FAIL engañoso en C2b: ponía `status='activo'` sobre un miembro
que ya estaba `activo` → `UPDATE` no-op → el trigger no dispara (correcto) →
parecía un agujero. El trigger **siempre** protegió `status` — las 6 columnas
privilegiadas están en el mismo `IF`. `sec_fix_checks.sql` se endureció: cada
ataque usa un valor distinto del actual, cubre las 6 columnas + las 2 vías
legítimas (admin por JWT, service_role) y devuelve filas. Sin migración nueva.
*(Nota: el approach `current_user='service_role' OR is_admin()` que se evaluó
habría roto `marcar_no_shows` — un RPC `SECURITY DEFINER` corre con
`current_user`=dueño, no `service_role`. El trigger actual,
`current_user='authenticated' AND NOT is_admin()`, lo maneja bien.)*

## Fixes de lógica (Sprint LOGIC-FIX)

Cierre de los bloqueantes de [LOGIC_AUDIT.md](LOGIC_AUDIT.md) antes del launch.
Migración `20260522100000_logic_fix.sql` — `CREATE OR REPLACE` de 3 RPCs core.

- **L-01 — horario sensible a la timezone de sesión.** `reservar_recurso_atomic`
  comparaba `p_slot_inicio::time` y `EXTRACT(DOW FROM p_slot_inicio)` contra
  `recursos.horarios` — ambos dependen del `timezone` de la sesión Postgres. El
  front manda instantes UTC; los bloques de horario están en hora de Culiacán.
  Con sesión UTC (default de Supabase), los slots de la tarde-noche se rechazaban
  con `EKKO_FUERA_DE_HORARIO`. Fix: anclar la conversión a `'America/Mazatlan'`
  (`tstz AT TIME ZONE 'America/Mazatlan'`) — correcto sea cual sea la TZ de
  sesión. Hardcodeado (single-tenant); mover a `tenants.config` con el 2º tenant.
- **L-02 — check-in aceptaba `cancelada_admin`.** `check_in_atomic` y
  `check_in_manual_atomic` validaban el estado con `IF` positivos enumerados;
  `cancelada_admin` (estado de RP-1, posterior a estas funciones) no matcheaba
  ninguno → una reserva cancelada por el estudio pasaba a `completada`. Fix: la
  rama de `cancelada` incluye `cancelada_admin` + un check negativo final
  (`!= 'confirmada'`) que atrapa cualquier estado futuro.
- **L-03 — `revocado` fuera del `CHECK`.** `revokeTeamMember()` escribe
  `status='revocado'` pero el `CHECK` de `usuarios.status` no lo admitía. La
  migración versiona el `CHECK` con `revocado` (idempotente — si la BD tenía
  drift, lo deja explícito).
- **L-15 — no se incluye:** `qr_token_hash` resultó columna muerta (nunca se
  escribe ni se lee — `qr-verify` valida el JWT por firma). Nulearla al cancelar
  sería un no-op. El riesgo real (QR viejo tras cancelar) lo cierra L-02.

Verificación: `supabase/tests/logic_fix_checks.sql`. Los 13 MEDIUM (−2 resueltos)
+ 5 LOW del audit quedan como hardening post-launch.

## Bloque A — Gobernanza (rediseño de recepción)

Prerrequisito de los Bloques B–F del rediseño de recepción
(`RECEPCION_REDESIGN_ANALYSIS.md`). Cierra la deuda de traza que dejó el "hub
de gestión": recepción ya podía cambiar status/tier/desbloqueo sin razón ni
auditoría confiable.

- **`audit_log` insert-only** (`20260611100000_audit_log.sql`): tenant, actor
  (usuario + rol), acción, target, `antes`/`despues` (jsonb), `motivo`,
  `creada_at`. RLS: INSERT solo `service_role` (sin policy para authenticated →
  bloqueado); SELECT admin = todo el tenant, recepción = solo `target_tipo='usuario'`;
  **sin policies de UPDATE/DELETE → inmutable por construcción**. Lo escriben las
  Netlify Functions con `service_role` vía `_lib/auditLog.ts` (`writeAuditLog`).
  Un fallo de auditoría NO rompe la operación principal (loguea y sigue).
- **Razón obligatoria** en status / tier / desbloqueo: el backend devuelve 400 si
  falta `motivo` (≥3 chars). La UI (`MotivoField`) ofrece motivos predefinidos +
  "Otro" (texto libre): en `EditarMiembroModal` (status/tier) y `DesbloquearModal`.
- **`notas_admin` separada del log** (cierra B1+B2): `reception-update-member` y
  `reception-reset-password` dejaron de anexar líneas a `notas_admin` (campo
  borrable por admin). La auditoría vive ahora en `audit_log`. `notas_admin`
  vuelve a ser solo notas humanas.
- **B4 — desbloqueo NO resetea `no_shows_count`**: antes ponía el contador en 0 en
  silencio. Ahora solo limpia `bloqueado_hasta`; el historial de inasistencias se
  conserva. El "perdón de historial" será acción aparte (Bloque D).
- **Acciones trazadas (v1):** `status_change`, `tier_change`, `unblock`,
  `contact_change`, `avatar_change`, `password_reset`, `create_member`. Las de
  reserva quedan fuera (ya tienen `cancelada_por` / `check_in_by`).
- **Historial de cambios** read-only en el perfil de recepción
  (`useAuditLogDeUsuario` + sección "HISTORIAL DE CAMBIOS").
- **No incluido (post-launch):** UI de admin del audit log global.

Verificación: `supabase/tests/audit_log_checks.sql` (estructural: RLS on, 0
policies de escritura, inmutabilidad). Tests de las funciones + modales + hook
en la suite (vitest).

## Bloque B + C — Agenda de recepción + Panel Hoy + nueva IA

Sigue al Bloque A en el rediseño de recepción para operar sin admin presente.
Solo UI + reuso — **sin migración SQL**.

- **Bottom-nav de 4 ítems** (`ReceptionBottomNav`, reusa `ek-bottom-nav`):
  **Hoy · Agenda · Miembros · Check-in**. Reemplaza los 2 tabs superiores.
  Rutas: `/recepcion` (Hoy), `/recepcion/agenda`, `/recepcion/miembros[/:id]`,
  `/recepcion/checkin`. El deep-link al perfil del miembro no cambió.
- **Hoy** (`pages/Hoy.tsx` → `ReservasHoyView`): panel del día con **ocupación**
  (sesiones activas + check-ins), llegadas, resto del día, **faltantes**
  (confirmadas cuyo horario ya pasó sin check-in — informativo; el cron las
  resuelve, recepción NO las marca acá → Bloque D) y check-in manual. Estados
  reales (skeleton/empty/filtros).
- **Agenda** (`pages/Agenda.tsx`): VER reservas read-only. Vista **Semana**
  (compartida) + **Lista** filtrable; default Semana en desktop / Lista en
  mobile (persistido). Tap → detalle read-only. NO se cancela/reprograma desde
  Agenda en v1: eso vive en el perfil del miembro (con contexto).
- **Check-in** (`pages/Checkin.tsx`): scanner QR dedicado (lo que era
  `Scanner.tsx`, sin el panel del día embebido). Lector HID + cámara +
  `qr-verify` + `CheckInDetail`. Scanner.tsx eliminado.
- **Reuso (estrategia híbrida):** `useReservasRango` movido a
  `@shared/hooks/` (admin lo re-exporta). `VistaSemana` extraído de
  `Calendario.tsx` a `@shared/components/calendario/` con prop
  `vistaCompactaCta` (Día en admin, Lista en recepción). `ReservasVistaLista` y
  `DetalleReservaModal` ganaron `onCancelar` **opcional** → sin ella = modo
  read-only (recepción los importa de admin sin duplicar). VistaSemana perdió
  su dependencia de `useRecursosAdmin` (la leyenda ya no muestra "Total
  recursos").
- **No incluido en B+C:** marcar no-show / corregir check-in (Bloque D), notas
  operativas + notificación manual (E), recurso fuera de servicio (F).

Sin regresiones de Bloque A: ningún flujo de B/C escribe en `notas_admin`; el
check-in manual sigue trazando con `check_in_by`/`check_in_method` (no requiere
`audit_log`). Tests: routing de los 4 tabs, toggle de Agenda, detalle read-only.

## Bloque D — No-shows manual + corregir check-in

Sigue a B+C en el rediseño de recepción. Cierra las capacidades #3/#4 del
análisis. **Sin migración SQL** — Netlify Functions con `service_role` sobre
tablas existentes, mismo patrón de gobernanza que Bloque A.

- **`reception-marcar-no-show`** (Netlify Function): marca una reserva puntual
  como `no_show` replicando el efecto del cron `marcar_no_shows`
  (`no_shows_count + 1`, `bloqueado_hasta = GREATEST(actual, now+7d)`). Motivo
  obligatorio; `audit_log` con `antes`/`despues`. Elegibilidad: `confirmada`,
  sin check-in, **`slot_fin < now`** (no exige el +30min del cron — recepción
  actúa con conocimiento directo; idempotente: el cron salta lo no-confirmada).
- **`reception-corregir-checkin`** (Netlify Function): deshace un check-in
  (`status → confirmada`, limpia `check_in_at`/`check_in_by`/`check_in_method`).
  Limitado al **mismo día** en `America/Mazatlan`; más viejo → escalar a admin.
  Motivo obligatorio; `audit_log`.
- **Audit targeteado al `usuario`** (no a `reserva`): la RLS de `audit_log` deja
  a recepción leer solo `target_tipo='usuario'`, así estas acciones aparecen en
  el "Historial de cambios" del perfil. El `reserva_id`/`folio` van en
  `metadata`. (Desviación deliberada del plan, que pedía `target_tipo='reserva'`
  — habría sido invisible para recepción sin tocar la RLS.)
- **UI:** en "Hoy", la sección **Faltantes** gana "Marcar no-show" por fila; el
  modal de check-in ya hecho gana "Corregir check-in" (secundario). Modales
  `MarcarNoShowModal` / `CorregirCheckinModal` con `MotivoField` (Bloque A).
- **Penalizados:** toggle **Buscar / Penalizados** en `BuscarMiembro` (Opción A,
  sin tab nuevo) → lista de `bloqueado_hasta > now`; tap → perfil, donde está el
  desbloqueo (Bloque A). NO se creó endpoint nuevo para levantar.
- **El cron `marcar_no_shows` sigue de noche**; el manual es complementario.
- **Deuda chica reportada:** el cron `marcar_no_shows` NO escribe `audit_log`
  (es anterior a Bloque A). Fuera de alcance de D.
- **No incluido:** notas operativas + notificación manual (E), recurso fuera de
  servicio (F).

## Onboarding de un tenant nuevo

Ver [TENANT_SETUP.md](TENANT_SETUP.md) en este mismo directorio.
