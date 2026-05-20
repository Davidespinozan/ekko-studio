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

## Onboarding de un tenant nuevo

Ver [TENANT_SETUP.md](TENANT_SETUP.md) en este mismo directorio.
