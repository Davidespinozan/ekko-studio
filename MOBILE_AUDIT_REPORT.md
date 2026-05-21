# Auditoría Mobile-First — EKKO Studio

**Fecha:** 2026-05-19
**Auditado por:** Claude Code (4 Explore agents paralelos por módulo)
**Scope:** member · reception · admin · public (read-only, sin cambios de código)
**Target devices:** iPhone SE 375×667 (mínimo), iPhone 13 Pro 390×844, iPad Mini 768×1024

---

## Resumen ejecutivo

EKKO se ve **premium en desktop pero frágil en mobile**. La auditoría detectó **48 findings** distribuidos en 4 módulos. La buena noticia: el viewport meta está bien configurado (`viewport-fit=cover` + `interactive-widget=resizes-visual`), el patrón `.ek-skeleton` está adoptado en miembro, y BottomNav + Scanner FAB ya usan `env(safe-area-inset-*)`. La mala: **3 issues bloquean operación crítica** (Admin Calendario inutilizable en mobile, Signup oculta CTA detrás del teclado, slot grid del miembro corta horarios).

**Grades por módulo** (inicial → tras MA1/MA2/R2/MA3):
| Módulo | Grade | Findings | Estado |
|--------|-------|----------|--------|
| **Member** | C+ → **B+** | 11 | ✅ todos resueltos |
| **Reception** | C+ → **B** | 17 | ✅ todos resueltos (`useScannerHID` descartado) |
| **Admin** | D → **B** | 16 | ✅ todos resueltos |
| **Public** | D+ → **B** | 13 | ✅ todos resueltos |
| **TOTAL** | C- → **B** | **48** | ✅ **AUDITORÍA COMPLETA — 48/48 findings cerrados** |

**Distribución por severidad:**
- 🔴 **CRITICAL: 3** → ✅ **3/3 resueltos** (MA1 ×2, MA2 ×1)
- 🟠 **HIGH: 10** → ✅ **10/10 resueltos** (MA1 ×3, MA2 ×7) — `useScannerHID` descartado: Cravia usa solo cámara, listener HID es dead code en su contexto.
- 🟡 **MEDIUM: 24** → ✅ **24/24 resueltos** (R2, MA3-Member, MA3-Admin, MA3-Public, MA3-Reception)
- 🟢 **LOW: 11** → ✅ **11/11 resueltos** (Member en MA3-Member · Reception/Admin/Public en MA4)

> **Estado: AUDITORÍA MOBILE COMPLETA.** Los 48 findings cerrados — 3 CRITICAL + 10 HIGH + 24 MEDIUM + 11 LOW. Los 4 módulos en grade B o mejor (Member B+, Admin B, Reception B, Public B). Sprint MA4 cerró los LOW restantes: Reception (limpiar-filtros 44px, padding safe-area, gap botones, day-nav 44px), Admin (Miembros header, HorariosEditor responsive, SectionToggle 44px), Public (hero gradient clamp, EstudioModal padding clamp, footer AAA con `--ek-ink`). Los LOW de Member ya se habían cerrado en MA3-Member.

### Top 5 issues más graves

> **✅ Los 5 resueltos en Sprint MA1** (commit en `main`). Ver sección "Mobile-first (Sprint MA1)" en KERNEL.md.

1. ~~**🔴 Admin Calendario — 7 columnas fijas a 375px**~~ → **RESUELTO MA1**: vista Día/Semana/Lista, default Día en mobile. `VistaDia` nuevo componente.
2. ~~**🔴 CardMenuDropdown 32×32 + items 32px alto**~~ → **RESUELTO MA1**: trigger 44×44, items `minHeight: 44px`. Propagado a 5 pantallas.
3. ~~**🟠 Signup CTA oculto detrás del teclado iOS**~~ → **RESUELTO MA1**: `100dvh` + `paddingBottom` safe-area + `scroll-into-view` on focus. (Nota: el `alignItems: center` estaba en Login, no Signup — ambos arreglados.)
4. ~~**🟠 Reservar slot grid se corta a 3 columnas**~~ → **RESUELTO MA1**: `repeat(4, 1fr)` garantiza 4 columnas a 375px.
5. ~~**🟠 Polling sin pause-on-blur en recepción**~~ → **RESUELTO MA1**: `useReservasHoy` pausa con `visibilitychange`, refetch al volver.

---

## 1. Findings por módulo

> **✅ Resueltos en MA2** (además de los 5 de MA1): Sidebar drawer safe-area + close 44×44 (CRITICAL #3) · Hamburger 44×44 · `.adm-form-row` apila en mobile · BotonCancelarReserva 44×44 · NotificacionesBanner ✕ 44×44 · ReservasVistaLista scroll + columna sticky · EstudioModal close 44×44 + safe-area. **`useScannerHID` descartado** (Cravia usa solo cámara). Los findings HIGH listados abajo quedan cerrados; los MEDIUM/LOW siguen abiertos para MA3/MA4.

### 1.1 MEMBER — Grade C+ → B+ (11 findings, ✅ todos resueltos)

> **✅ MA1:** slot grid. **✅ MA2:** BotonCancelarReserva + NotificacionesBanner ✕. **✅ MA3-Member:** los 5 MEDIUM + 3 LOW — fecha selector affordance, chips + padding de CancelarMiReservaModal, grids Dashboard/Estudios consistentes, Perfil info grid en filas, invitados +/− 44px, MiQR max-width guard, slots disabled (ya estaban OK).

#### 🟠 HIGH

##### Reservar — Slot grid se corta a 3 columnas en 375px
- **Archivo:** [src/member/pages/Reservar.tsx:284-319](src/member/pages/Reservar.tsx#L284)
- **Dimensión:** Calendar + Overflow
- **Problema:** `gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))'` + slot padding `14px 8px` → en 375px solo 3 slots visibles, los otros quedan cortados (sin scroll horizontal porque es grid, no flex).
- **Impacto:** Miembro no ve horarios completos. Bug original reportado.
- **Fix:** `gridTemplateColumns: 'repeat(4, 1fr)'` + reducir padding a `12px 4px`. O `minmax(60px, 1fr)` para garantizar 4 columnas a 375px.
- **Effort:** Medium

##### BotonCancelarReserva — Button tap area 24×12
- **Archivo:** [src/member/components/BotonCancelarReserva.tsx:75-91](src/member/components/BotonCancelarReserva.tsx#L75)
- **Dimensión:** Touch target
- **Problema:** `padding: 4px 8px` sin `minHeight`. Underline link efectivo ~24×12px.
- **Fix:** `minHeight: 44px, padding: 12px 16px, display: 'inline-flex', alignItems: 'center'`.
- **Effort:** Quick

##### NotificacionesBanner — Close ✕ es 16×16
- **Archivo:** [src/member/components/NotificacionesBanner.tsx:69-84](src/member/components/NotificacionesBanner.tsx#L69)
- **Dimensión:** Touch target
- **Problema:** Botón ✕ con `padding: 0 4px` y sin `minHeight`. Total ~16×16.
- **Fix:** `minWidth: 44px, minHeight: 44px, display: 'flex', alignItems: 'center', justifyContent: 'center'`.
- **Effort:** Quick

#### 🟡 MEDIUM

##### Reservar — Fecha selector sin affordance de scroll
- **Archivo:** [src/member/pages/Reservar.tsx:227-264](src/member/pages/Reservar.tsx#L227)
- **Problema:** 14 fechas con `overflowX: 'auto'` pero sin gradient/sombra. A 375px solo ~3.5 fechas visibles. Usuario cree que solo hay 4 días.
- **Fix:** `boxShadow: 'inset -12px 0 12px -8px rgba(0,0,0,0.3)'` en el container.
- **Effort:** Quick

##### CancelarMiReservaModal — Chips de sugerencia 20px alto
- **Archivo:** [src/member/components/CancelarMiReservaModal.tsx:169-189](src/member/components/CancelarMiReservaModal.tsx#L169)
- **Problema:** `padding: 6px 12px` → ~20px alto. Tap error en mobile.
- **Fix:** `padding: 10px 14px`.
- **Effort:** Quick

##### CancelarMiReservaModal — Modal cramped en 375px
- **Archivo:** [src/member/components/CancelarMiReservaModal.tsx:105-117](src/member/components/CancelarMiReservaModal.tsx#L105)
- **Problema:** `padding: 28px` + backdrop 20px → 295px usable interno. Textarea apretado.
- **Fix:** `padding: 'clamp(12px, 5vw, 28px)'`.
- **Effort:** Quick

##### Dashboard + Estudios — Grids minmax(180/240) inconsistente entre SE y Pro
- **Archivo:** [Dashboard.tsx:226](src/member/pages/Dashboard.tsx#L226), [Estudios.tsx:57](src/member/pages/Estudios.tsx#L57)
- **Problema:** SE 375px = 1 col; Pro 390px = 2 col. Visualmente "rota" en SE.
- **Fix:** `minmax(min(100%, 160px), 1fr)`.
- **Effort:** Medium

##### Perfil — Info grid colapsa raro
- **Archivo:** [src/member/pages/Perfil.tsx:142-171](src/member/pages/Perfil.tsx#L142)
- **Problema:** 6 cells stack vertical en 375px. Labels mono cramped.
- **Fix:** Flex column layout con full-width cells.
- **Effort:** Medium

#### 🟢 LOW

##### Reservar — Invitados +/− 40×40
- **Archivo:** [src/member/pages/Reservar.tsx:346-371](src/member/pages/Reservar.tsx#L346)
- **Fix:** `minHeight: 44px, minWidth: 44px`. Quick.

##### MiQR — Max-width 24rem sin guard de viewport
- **Archivo:** [src/member/pages/MiQR.tsx:189](src/member/pages/MiQR.tsx#L189)
- **Fix:** `maxWidth: 'min(24rem, 100%)'`. Quick.

##### Reservar — Disabled opacity 0.6 en OLED
- **Archivo:** [src/member/pages/Reservar.tsx:388](src/member/pages/Reservar.tsx#L388)
- **Fix:** opacity 0.5 + color faint explícito. Quick.

---

### 1.2 RECEPTION — Grade C+ (17 findings)

#### 🟠 HIGH

##### useReservasHoy — Polling sin pause-on-blur
- **Archivo:** [src/reception/hooks/useReservasHoy.ts:19-56](src/reception/hooks/useReservasHoy.ts#L19)
- **Dimensión:** Performance
- **Problema:** `setInterval(refetch, 30_000)` corre aunque iPad esté en background. M3 cerró esto para notificaciones miembro; recepción se quedó atrás.
- **Impacto:** Batería iPad en turnos largos + datos. Refresh stale al volver.
- **Fix:** Aplicar mismo patrón de `useNotificacionesMiembro.ts` (visibilitychange listener, pause/resume).
- **Effort:** Medium

##### useScannerHID — Conflicto con input focus en iOS Safari
- **Archivo:** [src/reception/hooks/useScannerHID.ts:24-29](src/reception/hooks/useScannerHID.ts#L24)
- **Dimensión:** Form + Interaction
- **Problema:** Listener global de keydown puede tragar teclas mientras recepcionista tipea en search. Inverso: Enter del scanner puede ser comido por input.
- **Fix:** Validar payload más estricto (regex QR format) + asegurar pause cuando hay input focus, no solo cuando hay modal abierto.
- **Effort:** Medium

#### 🟡 MEDIUM (10 findings — comprimidos)

> **✅ Resueltos (10/10):** R2 cerró 9 (search clear ✕ + edge, filter pills ✕, CameraModal close safe-area, CheckInDetail safe-area lateral, skeleton inicial, CameraModal retry de permiso, status badge contraste, polling pausa con modal abierto). **MA3-Reception** cerró el #9 (ManualCheckInModal safe-area lateral — `.rec-modal` con `max(24px, env(safe-area-inset-*))`).

| # | Componente | Issue | Archivo | Fix Quick |
|---|------------|-------|---------|-----------|
| 1 | ReservasHoyView | Search clear ✕ es 28×28 | [L321-342](src/reception/components/ReservasHoyView.tsx#L321) | min 44×44 |
| 2 | ReservasHoyView | Filter pills ✕ sin hit zone definido | [L383-420](src/reception/components/ReservasHoyView.tsx#L383) | min 44×44 |
| 3 | ReservasHoyView | Search clear muy pegado al edge | [L310](src/reception/components/ReservasHoyView.tsx#L310) | right 12px |
| 4 | CameraModal | Close button `top: -56px` (fuera safe-area) | [L68](src/reception/components/CameraModal.tsx#L68) | `top: calc(12px + env(safe-area-inset-top))` |
| 5 | CheckInDetail | Modal sin safe-area-inset-left/right | [L1009-1020](src/styles/ekko.css#L1009) | añadir env(...) |
| 6 | ReservasHoyView | Initial fetch sin skeleton | [L224-230](src/reception/components/ReservasHoyView.tsx#L224) | renderizar 5-10 skeletons |
| 7 | CameraModal | Sin retry button si rechaza permiso | [L70-76](src/reception/components/CameraModal.tsx#L70) | añadir retry CTA |
| 8 | ReservaCard status badge | Mustard sobre dark = 3:1 contraste | [L35-45](src/reception/components/ReservasHoyView.tsx#L35) | invertir bg/color |
| 9 | ManualCheckInModal | Padding 24px sin safe-area-left/right | [L645-723](src/reception/components/ReservasHoyView.tsx#L645) | usar calc + env() |
| 10 | Scanner+Polling | Polling sigue durante CheckInDetail open | [Scanner.tsx:56-57](src/reception/pages/Scanner.tsx#L56) | pasar flag pause |

#### 🟢 LOW (5 findings) — ✅ resueltos (MA4)

> **✅ MA4:** (1) "Limpiar filtros" → `minHeight: 44px`. (2) `.rec-main`
> padding L/R con `max(24px, env(safe-area-inset-*))`. (3) gap de botones
> del modal de check-in 8→12px. (4) day-nav arrows 40→44px. (5) N/A —
> el overflow del nombre ya estaba OK con ellipsis.

| # | Componente | Issue | Estado |
|---|------------|-------|--------|
| 1 | "Limpiar filtros" empty state | Botón 32px alto | ✅ MA4 |
| 2 | ReservasHoyView | Padding L/R sin safe-area-inset | ✅ MA4 |
| 3 | Manual check-in modal | Gap entre botones 8px (tight) | ✅ MA4 |
| 4 | Day nav arrows | 40×40 (debajo de 44) | ✅ MA4 |
| 5 | Card name overflow | OK con ellipsis, no fix | N/A |

---

### 1.3 ADMIN — Grade D → B (16 findings, ✅ todos resueltos)

> **✅ MA1:** Calendario, CardMenuDropdown. **✅ MA2:** Sidebar drawer safe-area + close, Hamburger, `.adm-form-row`, ReservasVistaLista. **✅ MA3-Admin:** los 7 MEDIUM — `.adm-modal` padding clamp, ConfirmDialog title wrap, `.adm-sidebar-item` 44px, DetalleReservaModal buttons stack, AdminDashboard MetricaCards 2-col. El #3 (topbar) se verificó: no estaba crowded (solo marca, sin page title) — sin cambio. El #7 (sidebar safe-area) ya estaba en MA2.

#### 🔴 CRITICAL

##### 🔴 Calendario — 7 columnas fijas inutilizables a 375px
- **Archivo:** [src/styles/ekko.css:1615](src/styles/ekko.css#L1615)
- **Dimensión:** Calendar + Overflow
- **Problema:** `.adm-cal-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }` sin breakpoint mobile. A 375px con padding: cada columna = **49px**. Day number 18px + event cards 11px font + 6px padding → texto ilegible, cards no se distinguen.
- **Impacto:** Magaly NO PUEDE usar Calendario en su iPhone. Hipótesis del usuario confirmada. Bug operativo bloqueante.
- **Fix:** `@media (max-width: 600px) { .adm-cal-grid { grid-template-columns: 1fr; gap: 16px; } }` → 1 día por row con sus reservas, scrollable vertical. O implementar toggle día/semana que defaulteé a "día" en mobile.
- **Effort:** Medium

##### 🔴 CardMenuDropdown — Botón ⋯ 32×32, items 32px alto
- **Archivo:** [src/admin/components/CardMenuDropdown.tsx:36, 81](src/admin/components/CardMenuDropdown.tsx#L36)
- **Dimensión:** Touch target
- **Problema:** Botón trigger `width: 32, height: 32, padding: 0`. Items dropdown `padding: 8px 12px` → ~32px alto. Usado en Recursos, Equipo, Tiers, MiembroDetalle, Cobranza — todas las acciones admin.
- **Impacto:** Magaly mis-tapea acciones (Editar/Eliminar/Duplicar) en cada list page.
- **Fix:** Trigger `width: 44, height: 44`. Items `padding: 12px 14px, minHeight: 44px`.
- **Effort:** Quick

##### 🔴 Sidebar drawer + Close button — Sin safe-area + 36×36
- **Archivo:** [src/admin/AdminLayout.tsx:36-46](src/admin/AdminLayout.tsx#L36) + [ekko.css:1410](src/styles/ekko.css#L1410)
- **Dimensión:** Safe area + Touch target
- **Problema:** Close button `width: 36, height: 36, top: 16px, right: 16px` sin `env(safe-area-inset-*)`. En iPhone con Dynamic Island, queda detrás del notch. Drawer `top: 0` sin `padding-top: env(safe-area-inset-top)`.
- **Fix:** Close button `width: 44, height: 44, top: max(16px, env(safe-area-inset-top))`. Drawer `padding-top: env(safe-area-inset-top), padding-left: env(safe-area-inset-left)`.
- **Effort:** Quick

#### 🟠 HIGH

##### ReservasVistaLista — Grid 7-col fijo overflow
- **Archivo:** [src/admin/components/ReservasVistaLista.tsx:347](src/admin/components/ReservasVistaLista.tsx#L347)
- **Problema:** `gridTemplateColumns: '120px 90px 1.2fr 1.5fr 90px 130px 40px'` (~567px min). Tiene `overflow-x: auto` pero columnas no adaptan.
- **Fix:** Mobile breakpoint → switch a card layout 1-col con campos apilados.
- **Effort:** Medium

##### Hamburger button — 40×40
- **Archivo:** [src/admin/AdminLayout.tsx:62](src/admin/AdminLayout.tsx#L62)
- **Fix:** 44×44. Quick.

##### `.adm-form-row` — No apila en mobile
- **Archivo:** [src/styles/ekko.css:1585](src/styles/ekko.css#L1585)
- **Problema:** Display flex row. 2 labels side-by-side a 375px = 170px cada uno (squish).
- **Fix:** `@media (max-width: 600px) { .adm-form-row { flex-direction: column; } }`.
- **Effort:** Quick

#### 🟡 MEDIUM (7)

| # | Componente | Issue | Fix |
|---|------------|-------|-----|
| 1 | `.adm-modal` | maxWidth 600 + padding 24 → cramped 287px | clamp padding mobile |
| 2 | ConfirmDialog | Long titles no wrap a 375px | word-wrap + font scale |
| 3 | AdminLayout topbar | Crowded: hamburger + title + spacer | hide eyebrow mobile |
| 4 | `.adm-sidebar-item` | 30px alto (padding 10px) | 14px vertical padding |
| 5 | DetalleReservaModal | Buttons row tight | stack vertical mobile |
| 6 | AdminDashboard | MetricaCards grid no optimizado | explicit 1fr mobile |
| 7 | Sidebar drawer | Safe-area-top no aplicado | env(safe-area-inset-top) |

#### 🟢 LOW (3) — ✅ resueltos (MA4)

> **✅ MA4:** (1) Miembros header → `flex-wrap` + gap (title y CTA ya no
> se pisan a 375px). (2) `HorariosEditor` → grid pasa a clase
> `.adm-horario-row` con media query: en ≤560px apila a 2 columnas y los
> inputs de hora dejan de quedar squish; desktop intacto. (3)
> `SectionToggle` → `minHeight: 44px`.

| # | Componente | Issue | Estado |
|---|------------|-------|--------|
| 1 | Miembros header CTA | Title + button wrap mal | ✅ MA4 |
| 2 | Tiers HorariosEditor | Grid 110px 1fr 1fr 90px squish | ✅ MA4 |
| 3 | Sidebar SectionToggle | Sin minHeight explícito | ✅ MA4 |

---

### 1.4 PUBLIC — Grade D+ → B (13 findings, ✅ todos resueltos)

> **✅ MA1:** Signup keyboard-aware. **✅ MA2:** EstudioModal close 44×44 + safe-area. **✅ S1:** Login keyboard-aware. **✅ MA3-Public:** los MEDIUM — nav buttons + footer social/links 44px, Hero CTA padding, lazy loading de cards, Signup plan summary sticky. El #4 (EstudioModal backdrop safe-area) se verificó: es modal centrado, no fullscreen — no aplica. El #7 (Login alignItems center) se resolvió en S1.

#### 🟠 HIGH

##### 🟠 Signup form — CTA oculto detrás del teclado iOS
- **Archivo:** [src/public/pages/Signup.tsx:180-385](src/public/pages/Signup.tsx#L180)
- **Dimensión:** Form
- **Problema:** `minHeight: 100vh, alignItems: center, padding: 40px 24px` sin `padding-bottom` para teclado. 8 campos de form + payment → cuando teclado iOS abre, submit "Pagar" queda detrás. **Pérdida directa de revenue**.
- **Fix:** (1) `paddingBottom: 'clamp(40px, calc(env(safe-area-inset-bottom) + 200px), 300px)'`. (2) Submit button con `position: sticky, bottom: 0` cuando teclado abierto.
- **Effort:** Large

##### 🟠 EstudioModal — Close ✕ 36×36 + sin safe-area
- **Archivo:** [src/public/components/EstudioModal.tsx:75-99](src/public/components/EstudioModal.tsx#L75)
- **Problema:** `width: 36, height: 36, right: 16px` sin `env(safe-area-inset-*)`. Notch interfiere.
- **Fix:** 44×44 + `right: max(16px, env(safe-area-inset-right))`.
- **Effort:** Medium

#### 🟡 MEDIUM (8)

| # | Componente | Issue | Effort |
|---|------------|-------|--------|
| 1 | PublicLayout nav buttons | minHeight: 40px | Quick |
| 2 | Hero CTA | padding 16px 28px tight | Medium |
| 3 | Landing estudios cards | Sin loading="lazy" | Quick |
| 4 | EstudioModal | Sin safe-area-top en backdrop | Medium |
| 5 | Footer social icons | 36×36 | Quick |
| 6 | Footer contact/nav links | fontSize 13 sin minHeight | Medium |
| 7 | Login form | minHeight 100vh + alignItems center oculta CTA | Medium |
| 8 | Signup plan summary | No sticky → se pierde al scrollear con teclado | Quick |

#### 🟢 LOW (3) — ✅ resueltos (MA4)

> **✅ MA4:** (1) Hero gradient → `right: clamp(-200px, -25vw, -80px)` —
> en pantallas chicas el glow ya no se va casi todo fuera de canvas. (2)
> `EstudioModal` → padding del cuerpo `clamp(16px, 5vw, 32px)`. (3)
> Footer links de contacto/navegación → `--ek-ink` en vez de
> `--ek-ink-muted`: contraste ≈17:1 sobre el fondo oscuro, **alcanza
> AAA** (≥7:1). No chocó con el diseño — links de footer legibles.

| # | Componente | Issue | Estado |
|---|------------|-------|--------|
| 1 | Hero gradient | right: -200px desperdiciado en SE | ✅ MA4 |
| 2 | EstudioModal | Padding no clamp | ✅ MA4 |
| 3 | Footer links | Contraste 4.5:1 (falla AAA) | ✅ MA4 (AAA) |

---

## 2. Calendarios y agendas — análisis profundo

El usuario flagged esto explícitamente. Resumen:

| Calendario | Archivo | Estado en 375px | Severidad |
|-----------|---------|----------------|-----------|
| **Admin /calendario** | [ekko.css:1615](src/styles/ekko.css#L1615) | **INUTILIZABLE** — 7 cols a 49px c/u | 🔴 CRITICAL |
| **Admin ReservasVistaLista** | [ReservasVistaLista.tsx:347](src/admin/components/ReservasVistaLista.tsx#L347) | Overflow horizontal, scroll lateral forzado | 🟠 HIGH |
| **Miembro /reservar slots** | [Reservar.tsx:284](src/member/pages/Reservar.tsx#L284) | Solo 3 slots visibles, resto cortados | 🟠 HIGH |
| **Miembro /reservar fechas** | [Reservar.tsx:227](src/member/pages/Reservar.tsx#L227) | Scroll horizontal sin affordance | 🟡 MEDIUM |
| **Recepción ReservasHoyView** | [ReservasHoyView.tsx](src/reception/components/ReservasHoyView.tsx) | OK estructura, falta skeleton + pause-on-blur | 🟠 HIGH |
| **Miembro Dashboard "próxima reserva"** | [Dashboard.tsx](src/member/pages/Dashboard.tsx) | OK | ✓ |

### Hipótesis del usuario — verificadas

| Hipótesis | Estado | Detalle |
|-----------|--------|---------|
| H1: Admin 7 cols → 53px stretch en 375px | ✅ **CONFIRMADO** | Mide 49px (peor que el cálculo del user) |
| H2: Selector slots miembro tap targets <44px | ✅ **CONFIRMADO** | minHeight 52px OK, pero solo 3 cols visibles |
| H3: Fecha picker type="date" raro en iOS | ❌ N/A | El proyecto NO usa type="date"; usa botones custom |
| H4: Switch Calendar/List solapa título | ⚠️ Parcial | Verificar en mobile real; código está en `ReservasVistaLista` con flex |

### Patrón recomendado para calendarios mobile

```css
/* Default desktop: 7 columnas */
.adm-cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}

/* Mobile: agenda vertical por día */
@media (max-width: 720px) {
  .adm-cal-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .adm-cal-day {
    /* Día como bloque grande con todas sus reservas */
    border-left: 3px solid var(--ek-mustard);
    padding: 16px;
  }
}
```

Alternativa: **toggle Vista (Día / Semana / Lista)** que defaultee a "Día" en mobile.

---

## 3. Patrones de fix recomendados

### 3.1 Touch target 44×44 universal

```ts
// Wrapper helper para botones inline-styled
const tapTarget = {
  minWidth: '44px',
  minHeight: '44px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center'
};
```

Aplicar a: NotificacionesBanner ✕, BotonCancelarReserva, CardMenuDropdown trigger + items, Sidebar close, Hamburger, EstudioModal ✕, Footer social icons, footer links, ReservasHoyView search clear + filter pills, day nav arrows.

### 3.2 Safe-area en elementos fixed/sticky

```css
/* Padding-aware: top */
padding-top: max(16px, env(safe-area-inset-top, 0px));

/* Calc-aware: bottom (FAB, BottomNav) */
bottom: calc(24px + env(safe-area-inset-bottom, 0px));

/* Modal/drawer fullscreen */
padding-left: env(safe-area-inset-left, 0px);
padding-right: env(safe-area-inset-right, 0px);
padding-top: env(safe-area-inset-top, 0px);
padding-bottom: env(safe-area-inset-bottom, 0px);
```

### 3.3 Keyboard-safe forms

```ts
// Form container
style={{
  paddingBottom: 'clamp(40px, calc(env(safe-area-inset-bottom, 0px) + 200px), 300px)'
}}

// Submit button cuando form es largo
style={{
  position: 'sticky',
  bottom: 'env(safe-area-inset-bottom, 0px)',
  zIndex: 10
}}
```

### 3.4 Grids responsive con guard

```ts
// Mal: rompe en 375px si minmax > viewport / cols
gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))'

// Bien: garantiza N cols a 375px
gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))'

// O explícito
gridTemplateColumns: 'repeat(2, 1fr)' // mobile
@media (min-width: 720px) { gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }
```

### 3.5 Pause-on-blur polling reusable

Extraer pattern de [useNotificacionesMiembro.ts](src/shared/hooks/useNotificacionesMiembro.ts) a un hook compartido `useVisibilityAwarePolling(callback, intervalMs)`. Aplicar a `useReservasHoy`, futuros pollings de admin (cobranza, etc.).

### 3.6 Table → Card layout en mobile

Para `.adm-table` y `ReservasVistaLista`:

```css
@media (max-width: 600px) {
  .adm-table thead { display: none; }
  .adm-table tr {
    display: flex;
    flex-direction: column;
    padding: 16px;
    border-radius: 12px;
    background: var(--ek-bg-soft);
    margin-bottom: 12px;
  }
  .adm-table td::before {
    content: attr(data-label);
    font-size: 11px;
    color: var(--ek-ink-muted);
    display: block;
  }
}
```

---

## 4. Plan de sprints recomendado

### Sprint MA1 — CRITICALS bloqueantes (4-6h)
**Target: poder usar EKKO en iPhone sin frustración inmediata**

1. **Admin Calendario → vista mobile** ([ekko.css:1615](src/styles/ekko.css#L1615)) — Medium, 2h
2. **CardMenuDropdown 44×44** ([CardMenuDropdown.tsx](src/admin/components/CardMenuDropdown.tsx)) — Quick, 20min
3. **Sidebar drawer + close button safe-area** ([AdminLayout.tsx](src/admin/AdminLayout.tsx), [ekko.css:1410](src/styles/ekko.css#L1410)) — Quick, 30min
4. **Signup CTA keyboard-safe** ([Signup.tsx:180](src/public/pages/Signup.tsx#L180)) — Large, 2h
5. **Reservar slot grid → 4 cols garantizadas** ([Reservar.tsx:284](src/member/pages/Reservar.tsx#L284)) — Medium, 1h

**Tests obligatorios (post-verificación, regla del usuario):**
- Unit: CardMenuDropdown render con menos items
- Visual snapshot a 375px de Calendario, Sidebar abierta, Signup con teclado simulado
- E2E playwright: signup desktop + mobile flow

### Sprint MA2 — HIGH priority (4-5h)
**Target: cerrar gaps de operación en cada módulo**

1. ReservasVistaLista → card layout mobile (Medium, 1.5h)
2. `.adm-form-row` flex-direction column mobile (Quick, 15min)
3. Hamburger 44×44 (Quick, 5min)
4. BotonCancelarReserva 44×44 (Quick, 10min)
5. NotificacionesBanner ✕ 44×44 (Quick, 10min)
6. useReservasHoy pause-on-blur + extract `useVisibilityAwarePolling` hook (Medium, 1h)
7. useScannerHID tighten validation + input focus check (Medium, 1h)
8. EstudioModal close 44×44 + safe-area (Medium, 30min)

**Tests:** `useVisibilityAwarePolling` hook con fake timers (mismo patrón que M3).

### Sprint MA3 — MEDIUM polish (5-6h)
**Target: levantar todos los grades a B/B+**

- Member: CancelarMiReservaModal chips + padding (Quick, 30min total)
- Member: Dashboard/Estudios grid responsive (Medium, 1h)
- Member: Reservar fecha scroll affordance (Quick, 15min)
- Reception: 8 fixes de touch target + safe-area + skeleton (Medium, 2h)
- Reception: CameraModal retry permission (Medium, 30min)
- Reception: Status badge contraste (Quick, 15min)
- Admin: Modal width responsive (Quick, 20min)
- Admin: Sidebar items 44px (Quick, 10min)
- Admin: ConfirmDialog wrap (Quick, 15min)
- Public: 6 fixes touch target + lazy loading + footer (Medium, 1.5h)

### Sprint MA4 — LOW polish (post-launch, opcional, 2-3h)
- MiQR max-width guard
- Hero gradient clamp
- Footer contrast AAA
- Dashboard MetricaCard mobile grid
- Tiers HorariosEditor grid
- Reservar opacity feedback
- Misc

---

## 5. Riesgos y decisiones

### 5.1 Admin Calendario — decisión de diseño

El fix CSS rápido (`1fr` mobile, 1 día por row) funciona pero NO es óptimo UX. Hay 3 opciones:

| Opción | Esfuerzo | UX en mobile |
|--------|----------|--------------|
| A. CSS `1fr` mobile (1 día/row) | 30min | Funciona, scroll vertical largo |
| B. Toggle Día/Semana/Lista con default "Día" en mobile | 3-4h | Óptimo |
| C. Reusar ReservasVistaLista como default mobile | 2h | Bueno, menos contexto temporal |

**Recomendación:** Opción B post-launch, Opción A ya en MA1.

### 5.2 ReservasVistaLista — tabla vs cards

Esta tabla se usa en `/admin/calendario` (vista Lista) y posiblemente otras. Cambiar a card layout en mobile rompe densidad para admins acostumbrados al desktop. **Decisión:** mantener tabla en mobile con `overflow-x: auto` + sticky first column (folio), no rehacer como cards.

### 5.3 Signup keyboard-safe — interaction-widget ya está

El meta `interactive-widget=resizes-visual` (index.html:8) ya hace que el viewport se reduzca cuando el teclado abre. El problema NO es viewport — es el layout `alignItems: center` que mantiene el form centrado en el espacio reducido. Fix de `alignItems: flex-start` + `paddingTop: 40px` sirve.

### 5.4 HID scanner + iOS Safari

Si Cravia usa iPad con teclado bluetooth scanner físico, OK. Si usan iPad sin scanner físico (escanean con cámara), el listener HID es **dead code** en ese contexto. Verificar con el usuario qué hardware vamos a desplegar antes de invertir tiempo en endurecer el listener.

### 5.5 Tests post-fix

La regla del usuario es **tests post-verificación**. Para esta auditoría, recomiendo:

- **Visual regression**: Playwright + screenshot a 375×667 de cada pantalla crítica antes/después de cada sprint
- **Unit**: nuevos hooks compartidos (`useVisibilityAwarePolling`) con fake timers
- **E2E happy path**: signup flow + reservar flow + check-in flow a 375px viewport

Tiempo estimado de testing por sprint: 30-50% del tiempo de implementación.

---

## 6. Apéndice — herramientas de testing

### Mobile testing setup recomendado

1. **Chrome DevTools** → Toggle device toolbar → iPhone SE (375px), iPhone 13 Pro (390px)
2. **iPhone real**: USB → Safari → Develop → [iPhone] → ekko-studio.netlify.app (Safari nativo es el target, no Chrome iOS)
3. **iPad**: real device for recepción (HID listener no se prueba en simulator)
4. **Playwright** con viewports definidos:

```ts
// playwright.config.ts
projects: [
  { name: 'iphone-se', use: devices['iPhone SE'] },
  { name: 'iphone-13-pro', use: devices['iPhone 13 Pro'] },
  { name: 'ipad-mini', use: devices['iPad Mini'] }
]
```

### Métricas a trackear post-fixes

- **CLS** (Cumulative Layout Shift) — sticky CTAs no deben sumar
- **LCP** (Largest Contentful Paint) — hero landing < 2s 3G
- **INP** (Interaction to Next Paint) — tap response < 200ms
- **Tap accuracy** (no nativa de browser; mide en analytics events si hay)

---

## Conclusión

EKKO tiene **estructura sólida** (viewport, safe-area en BottomNav, skeletons consistentes en miembro post-M3) pero **muchos detalles mobile sin pulir** — clásico de proyecto que prioriza features sobre QA mobile.

**El 80% de los issues son fixes <30min** (touch targets, padding, safe-area). El 20% requiere decisiones de diseño (Calendario admin, table→card vs scroll).

Después de Sprint MA1 (4-6h), Cravia debería poder operar todo el sistema en iPhone sin frustración. Después de MA2+MA3 (~10h adicionales), EKKO sube a Grade B/B+ en mobile, comparable a SaaS premium de la categoría.

**Recomendación:** ejecutar MA1 antes del QA con Magaly. MA2 y MA3 antes del go-live público. MA4 post-launch.
