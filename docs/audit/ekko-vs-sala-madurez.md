# Qué puede aprender EKKO de SALA para madurar

> Análisis comparativo, factual. Leí el repo `davidespinozan/sala-studio`
> (clonado a `/tmp/sala-studio`) y lo contrasté con EKKO (que conozco a fondo).
> Documento interno, no commiteado.
>
> **Importante:** EKKO y SALA están **forkeados de una base común** (misma
> estructura de módulos, `ErrorBoundary`, `sentry.ts` frontend, `zustand`,
> `AppShell`, tablas `membresias`/`tiers`/`reservas`...). Por eso muchas cosas
> que parecían "ventaja de SALA" en realidad **EKKO también las tiene**. Los
> gaps reales son más acotados y por eso más accionables.
>
> Vocabulario: SALA = socio/clase/membresía/gym/sede (multitenant, fitness).
> EKKO = miembro/reserva/recurso/estudio (single-tenant Cravia, creator studio).
> Donde recomiendo para EKKO, uso vocabulario EKKO.

---

## 0. Escala (contexto)

| | EKKO | SALA |
|---|---|---|
| Archivos TS/TSX | ~? (menor) | **251** |
| Líneas TS/TSX | menor | **~50.5k** |
| Migraciones SQL | ~32 | **150** |
| Tests unitarios (vitest) | **220** ✅ | 156 |
| E2E (playwright) | placeholder | Fase 1 real (en CI) |
| CI/CD | solo placeholder | **ci.yml real** |

SALA es ~2× en superficie y mucho más en migraciones (más features: multi-sede,
mapa de salón, reportes, lifecycle de membresía, créditos/lista de espera). Pero
**EKKO tiene más tests unitarios** y una capa de **gobernanza/auditoría que SALA
no muestra** (ver §"Dónde EKKO ya está igual o mejor").

---

## 1. Matriz de madurez (lo que importa)

| Dimensión | EKKO | SALA | ¿Gap real para EKKO? |
|---|---|---|---|
| **Pagos / Stripe** | inexistente, signup simulado, `membresias` casi sin uso | **plug-and-play**: flujo cableado, activación en 1 RPC, webhook esqueleto, `tiers.stripe_price_id`, marcadores `TODO STRIPE` | **SÍ — el gap #1** |
| **Lifecycle de membresía** | `usuarios.status` plano + `membresia_tier`; tabla `membresias` existe pero **no se usa** | tabla `membresias` como **state machine real** (activa/pausada/vencida/cancelada/trial/past_due) escrita por `activar_suscripcion_socio` | **SÍ** (atado a Stripe) |
| **CI/CD** | solo `e2e-smokes.yml` placeholder (noop) | **`ci.yml`**: lint+tsc+test+build+e2e en cada push/PR, con `concurrency cancel` | **SÍ — barato, alto valor** |
| **Timezone** | `'America/Mazatlan'` **hardcodeado** inline (JS + SQL) | `date-fns-tz` + `src/shared/lib/timezone.ts` centralizado + tests | **SÍ** |
| **Disciplina de docs** | KERNEL.md + audits | `DECISIONS.md` (D-NNN), `BACKLOG.md` (tiered), `STRIPE.md`, `E2E.md` (runbook staging) | **SÍ — barato** |
| **E2E + staging** | placeholder | Fase 1 read-only en CI + runbook de staging escrito para Fase 2 | **SÍ** |
| **Onboarding de tenant** | manual (`TENANT_SETUP.md`) | `onboarding-crear-gym` (self-serve) | parcial (EKKO es single-tenant) |
| **scripts/ de validación** | drift de schema | regresión de color, contraste de sidebar, audit de membresías, pwa icons | menor |
| **Observabilidad (Sentry frontend)** | `sentry.ts` real + `ErrorBoundary` ✅ | idem | **NO — empatados** |
| **State (zustand)** | sí ✅ | sí | **NO** |
| **Estructura de módulos** | admin/member/reception/public/shared ✅ | idem (+ `providers/`, `utils/`) | casi empatados |
| **Auditoría / gobernanza** | **audit_log insert-only + razón obligatoria + trigger C2** ✅ | no aparece equivalente | **EKKO ADELANTE** |

---

## 2. Recomendaciones priorizadas (impacto / esfuerzo)

### #1 — Adoptar el patrón "Stripe plug-and-play" de SALA 🔴 (impacto máximo)

Es el destrabe del lanzamiento de EKKO y SALA ya resolvió **la arquitectura**
(no solo "puso Stripe"). La clave: **la activación de la cuenta vive en UN solo
lugar** y conectar Stripe es reemplazar 2 bloques marcados.

**Cómo lo hace SALA (a copiar tal cual, con vocabulario EKKO):**
1. **Un RPC único de activación** — `activar_suscripcion_socio(usuario_id,
   tier_id, stripe_subscription_id?, stripe_customer_id?, periodo_fin?)`. Crea/
   renueva la fila en `membresias` y pone la cuenta en `activa`. **Lo llaman
   tanto el mock del demo como el webhook real** → una sola fuente de verdad de
   activación. (EKKO: hoy "activar" = cambiar `usuarios.status` a mano desde
   recepción; debería ser este RPC.)
2. **`suscribir-membresia`** (Netlify): identifica al socio, valida el tier, y
   - demo → activa simulado (llama el RPC) → `{ activated: true }`;
   - real sin Stripe → `{ activated: false, reason: 'stripe_pendiente' }`;
   - con Stripe (futuro) → crea `checkout.sessions.create({ mode:'subscription',
     price: tier.stripe_price_id, metadata:{ usuario_id, tier_id } })` y devuelve
     `{ url }`. **El bloque a reemplazar está marcado `[TODO STRIPE]`.**
3. **`stripe-webhook`** (Netlify, esqueleto): mientras no haya
   `STRIPE_WEBHOOK_SECRET`, responde 200 no-op (no rompe el deploy). Al conectar:
   verifica firma → mapea `checkout.session.completed`/`subscription.updated` al
   **mismo RPC de activación**, `subscription.deleted` → `cancelada`.
4. **Front:** `iniciarCheckout(tierId)` (`src/shared/lib/checkout.ts`) llama la
   function y, si vuelve `{ url }`, redirige. Hoy ya funciona para demo/real sin
   tocar UI al conectar Stripe.
5. **`tiers.stripe_price_id`** ya existe como columna (vacía hasta cargar).
6. **`STRIPE.md`** documenta "los 3 pasos para conectar" + una tabla de
   touchpoints de UI que "se encienden" (Método de pago, Historial de pagos,
   banner de membresía pendiente → auto-pago sin recepción), cada uno con un
   comentario `TODO STRIPE` greppable.

**Qué haría EKKO concretamente (sin cobrar todavía, dejándolo plug-and-play):**
- Crear `activar_membresia(p_usuario_id, p_tier_id, ...)` que escriba la tabla
  `membresias` (hoy muerta) y ponga `usuarios.status='activo'`. **Esto cierra de
  paso el bug B3** (cambiar tier no activa) — porque activar pasaría por este RPC.
- Crear `suscribir-membresia` + `change-plan` que llamen ese RPC (demo activa,
  real `stripe_pendiente`).
- Crear `stripe-webhook` esqueleto + columna `stripe_price_id` (ya está) + un
  `STRIPE.md`.
- Marcar los touchpoints con `TODO STRIPE`.
- **Resultado:** el día que David decida D4, conectar Stripe es ~3 pasos, sin
  reescribir la activación ni la UI. Y mientras tanto, recepción/auto-activación
  ya quedan consistentes (no más "status a mano" inconsistente).

> Esto convierte el bloqueante #1 de EKKO (pagos) de "feature enorme por hacer"
> a "infra ya lista, falta enchufar la llave".

### #2 — CI/CD automatizado 🟢 (barato, alto valor)

SALA corre en **cada push y PR a main**: `lint` (max-warnings 0) + `tsc --noEmit`
+ `vitest` + `build`, con `concurrency: cancel-in-progress`, y un job e2e que
sirve el build con `vite preview`. EKKO solo tiene un `e2e-smokes.yml` placeholder
**noop** — los gates (que ya corremos a mano en cada bloque) **no están
automatizados**.

**Adoptar:** copiar `ci.yml` de SALA casi tal cual (mismo stack: Node 22, npm ci,
lint/tsc/test/build). Es ~30 líneas y convierte "me acuerdo de correr el gate" en
"el PR no mergea si está rojo". Dado que EKKO ya tiene 220 tests verdes, el ROI es
inmediato.

### #3 — Centralizar timezone con `date-fns-tz` 🟡

EKKO hardcodea `'America/Mazatlan'` en SQL (RPCs de reserva, check-in, no-show) y
en JS (corregir-checkin, etc.) — disperso y fácil de olvidar. SALA tiene
`src/shared/lib/timezone.ts` + `date-fns-tz` + tests, usado consistentemente.

**Adoptar:** un `src/shared/lib/timezone.ts` con la zona del tenant y helpers
(`diaEnZona`, `mismaFechaEnZona`, formatters), y reemplazar los `Intl`/strings
sueltos. Reduce bugs de borde (medianoche, DST) y centraliza la única zona.

### #4 — Disciplina de docs: DECISIONS.md + BACKLOG.md 🟢 (barato)

SALA mantiene:
- **`DECISIONS.md`** — decisiones durables numeradas `D-NNN` con estado/fecha/
  consecuencia (ej. D-021: dos capas de color marca vs semántica). EKKO referencia
  decisiones (D1..D6, R3, R6, H1..H5) **dispersas en comentarios** — un índice
  numerado las haría rastreables.
- **`BACKLOG.md`** — pendientes priorizados por tiers + estrategia competitiva +
  "Hecho (referencia)". EKKO no tiene backlog vivo (lo llevamos en el chat).

**Adoptar:** arrancar `DECISIONS.md` (migrar las D1–D6/H1–H5/R-NN que ya viven en
comentarios) y un `BACKLOG.md` con lo que quedó (D4/pagos, B3, reprogramar
atómico, refactors). Barato y ordena la cabeza del proyecto.

### #5 — E2E Fase 2 + staging 🟡

SALA tiene `E2E.md` con un **runbook concreto** para montar Supabase de staging y
correr e2e con login que mutan datos (reservar→cancelar, check-in, comprar plan)
sin tocar prod, con cuentas de test fijas. EKKO tiene `playwright.config.ts` pero
e2e en placeholder.

**Adoptar (cuando exista staging):** el mismo patrón — staging aislado, 3 cuentas
de test (admin/recepción/miembro), specs que limpian lo que crean. Da una red de
seguridad real sobre los flujos críticos (check-in, reservar, cancelar).

### #6 — `activar` el lifecycle real de `membresias` 🟡 (va con #1)

EKKO ya **tiene** la tabla `membresias` (con estados activa/cancelada/past_due/
trialing) pero está **muerta** (solo se cuenta para hard-delete guard). SALA la
usa como state machine vía el RPC de activación. Al hacer #1, EKKO debería empezar
a escribir `membresias` de verdad (trial→activa→vencida/cancelada) en vez de
depender solo de `usuarios.status` plano. Esto habilita "Historial de pagos",
"método de pago", y reportes de MRR a futuro.

---

## 3. Dónde EKKO YA está igual o MEJOR (balance honesto)

No todo es déficit. EKKO **lidera** o empata en:
- **Cobertura de tests unitarios**: 220 (EKKO) vs 156 (SALA).
- **Gobernanza/auditoría**: EKKO tiene `audit_log` **insert-only** + **razón
  obligatoria** en acciones sensibles + **trigger C2** (columnas privilegiadas) +
  separación de `notas_admin`/`notas_miembro`. No vi un equivalente en SALA. Es un
  diferencial de madurez **a favor de EKKO**.
- **Observabilidad frontend**: Sentry real + ErrorBoundary — empatados (base común).
- **Estructura, state (zustand), error translation, mobile-first** — empatados.

O sea: SALA está más maduro en **monetización, lifecycle de membresía, CI y
proceso (docs/e2e)**; EKKO está más maduro en **tests y gobernanza de datos**. No
es "SALA gana en todo" — son fortalezas distintas, y lo eficiente es **portar de
SALA justo donde EKKO está flojo**.

---

## 4. Plan sugerido (orden por ROI)

1. **CI `ci.yml`** (1 archivo, ~30 líneas) — gate automático ya mismo. *Horas.*
2. **DECISIONS.md + BACKLOG.md** — ordenar el proyecto. *Horas.*
3. **Stripe plug-and-play** (#1 + #6): RPC `activar_membresia` + `suscribir-
   membresia` + `stripe-webhook` esqueleto + `STRIPE.md` + marcadores. **Cierra B3
   de paso y deja los pagos a una llave de distancia.** Requiere antes la decisión
   **D4** de David (modelo de cobro). *Días.*
4. **Timezone centralizado** — `shared/lib/timezone.ts` + date-fns-tz. *Día.*
5. **E2E Fase 2** cuando haya staging. *Días.*

> Nada de esto es "copiar features de SALA" (mapa de salón, multi-sede, reportes)
> — eso es de su nicho fitness multitenant y no aplica a EKKO single-tenant. Lo
> que se porta es **madurez de plataforma**: pagos como infra, CI, TZ, proceso.

---

## 5. INTERFAZ VISUAL (qué aprender en UI/diseño)

> Hallazgo que confirma el linaje: el `tokens.css` de SALA mapea `--ek-cream →
> var(--sala-bg)` como **aliases legacy** — o sea **SALA fue forkeado de EKKO**
> (la base "STRYV cream/mustard") y **evolucionó el sistema de diseño**. EKKO es
> la v1; SALA maduró visualmente encima. El CSS pesa casi lo mismo (EKKO 2825 /
> SALA 3028 líneas), así que el delta no es "cantidad" sino **profundidad de
> tokens + componentes de pulido + micro-interacciones**.

### 5.1 Sistema de tokens — SALA tiene ~3× más profundidad

| | EKKO | SALA |
|---|---|---|
| Derivadas por color de marca | **4** (`mustard`, `-deep`, `-dim`, `-soft`) | **13** (`-active, -darkest, -dim, -focus-ring, -glow, -glow-strong, -hover, -light, -shadow, -soft, -tint, -text`) |
| Semánticos con variantes | colores planos | `error/warning/success` con `-bg/-dim/-glow/-hover/-shadow` |
| Easing premium nombrado | no (`--ease-*` inexistente) | `--ease-premium` |
| Escala tipográfica token | no | `--sala-font-scale` |
| Texto-sobre-color computado | no | `--text-on-primary` / `-on-accent` |

**Consecuencia visual:** SALA puede dar **profundidad y cohesión** — botones con
*glow*, *focus rings* tintados, sombras tintadas, estados hover/active definidos
por token — mientras EKKO usa el mustard plano + 3 sombras neutras. Se ve más
"premium" no por colores distintos sino por el **ramp** completo.

> **Para EKKO (single-tenant, conservando "Mostaza Ink"):** NO hace falta el
> branding dinámico por tenant (eso es de SALA multitenant). Lo que sí conviene
> es **enriquecer el ramp fijo**: agregar `--ek-mustard-glow`,
> `-focus-ring`, `-hover`, `-active`, `-tint`, `-shadow`, y `success/danger/
> warning` con `-bg`/`-dim`. Da el salto de pulido sin rebrandear.

### 5.2 Componentes de pulido que SALA tiene y EKKO NO

| Componente SALA | Qué aporta | EKKO hoy |
|---|---|---|
| **PageHeader** | header de página consistente (eyebrow + título + subtítulo + slot derecho) | **No existe** — 14 archivos de recepción **arman el header a mano** (eyebrow+título inline). Inconsistencia + duplicación. |
| **ConexionBanner** | banner global offline (escucha `online/offline`) — evita que acciones fallen en silencio sin red | **No existe** — sin red, pantallas vacías sin explicación |
| **PwaInstallBanner** | invita a instalar la PWA (gates por plataforma, instrucción iOS, dismiss 90 días, delay 4s) | **No existe** — EKKO es PWA pero no invita a instalar (clave para el iPad de recepción) |
| **MagneticButton** | CTA "magnético" que sigue al cursor (desktop, respeta reduced-motion) | **No existe** — CTAs del landing estáticos |
| **HeroCarousel** | carrusel de hero en el landing | landing más estático |
| **NotificacionesBell** | campana de notificaciones | EKKO tiene banner de notif del miembro (menos pulido) |
| **AppShell / AppSidebar** | chrome de app consistente abstraído | EKKO arma cada layout a mano |

### 5.3 Recomendaciones visuales priorizadas (EKKO single-tenant)

1. **PageHeader compartido** 🟢 — portar y reemplazar los 14 headers
   hand-rolled de recepción (+ admin). Consistencia inmediata y menos código.
   *El más barato y visible.*
2. **Enriquecer el ramp de tokens** 🟡 — mustard con `glow/focus-ring/hover/
   active/tint/shadow` + semánticos con `-bg/-dim`. Sube el "premium feel" en
   todo el sistema sin tocar la identidad. *Medio.*
3. **ConexionBanner** 🟢 — UX offline; coherente con la filosofía EKKO de "no
   trabar al mostrador con cliente delante". *Barato.*
4. **PwaInstallBanner** 🟡 — EKKO es PWA pero no invita a instalar; importa para
   el iPad de recepción y el móvil del miembro. *Medio.*
5. **`--ease-premium` + MagneticButton + HeroCarousel** 🔵 — pulido del landing
   (premium feel). *Menor prioridad — cosmético.*

> Igual que en plataforma: **NO** copiar las features visuales de su nicho (mapa
> de salón, multi-sede, branding por tenant). Lo que se porta es **profundidad de
> tokens + componentes de consistencia/pulido + UX de borde (offline, PWA)**.

---

*Fin. Repo SALA clonado en `/tmp/sala-studio` (se puede borrar). Documento
read-only, no commiteado.*
