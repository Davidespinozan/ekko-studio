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

## Onboarding de un tenant nuevo

Ver [TENANT_SETUP.md](TENANT_SETUP.md) en este mismo directorio.
