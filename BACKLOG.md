# Backlog — EKKO Studio

Lista viva de pendientes. Marcá `[x]` lo hecho. Orden = prioridad sugerida.
El detalle de decisiones está en `DECISIONS.md`; la arquitectura en `KERNEL.md`.

---

## 1. Lo grande — Pagos / Stripe (bloqueante de lanzamiento)

> Hoy: signup simulado, "cambiar plan" por WhatsApp. Sin pasarela.
> Requiere primero la decisión **D4** (modelo de cobro).

- [ ] **Definir D4** (David): suscripción mensual por tier vs pago único; trial
      sí/no; self-serve (checkout) vs cobro en mostrador.
- [ ] **Andamiaje plug-and-play** (patrón de SALA, ver `docs/audit/ekko-vs-sala-madurez.md`):
  - [ ] RPC **único de activación** `activar_membresia(usuario_id, tier_id, ...)`
        que escriba la tabla `membresias` (hoy muerta) y ponga `status='activo'`.
        **Cierra B3 de paso.**
  - [ ] `suscribir-membresia` (Netlify): demo activa simulado / real
        `stripe_pendiente` / con Stripe → Checkout Session.
  - [ ] `stripe-webhook` esqueleto (no-op sin `STRIPE_WEBHOOK_SECRET`).
  - [ ] Cargar `tiers.stripe_price_id` por plan + `STRIPE.md` + marcadores
        `TODO STRIPE`.

## 2. Deudas técnicas conocidas

- [ ] **B3 — cambiar tier no activa la cuenta** (se cierra con el RPC de
      activación de Pagos).
- [ ] **D6 — reprogramar no atómico**: revisar si vale un RPC atómico (hoy
      maneja parciales con avisos, pero puede dejar al miembro sin reserva).
- [ ] **Comentario obsoleto** en `PerfilMiembroRecepcion.tsx` ("READ-ONLY") — ya
      es un hub de gestión.
- [ ] **Timezone centralizado** — `shared/lib/timezone.ts` + `date-fns-tz` en vez
      de `'America/Mazatlan'` hardcodeado en SQL y JS.

## 3. CI / testing

- [ ] **Habilitar el job e2e** del CI: cargar secrets `VITE_SUPABASE_*` +
      `vars.RUN_E2E=true` en el repo. (El smoke `e2e/tests/smoke-landing.spec.ts`
      ya existe.)
- [ ] **E2E Fase 2** (con login, mutan datos) — requiere Supabase de **staging**
      aislado + 3 cuentas de test. Flujos: reservar→cancelar, check-in, comprar
      plan, reportes.
- [ ] Borrar `.github/workflows/e2e-smokes.yml` (placeholder noop, redundante con
      `ci.yml`).

## 4. Madurez visual (aprendido de SALA — ver `docs/audit/ekko-vs-sala-madurez.md`)

- [ ] **PageHeader compartido** — reemplazar los headers hand-rolled de recepción.
- [ ] **ConexionBanner** — banner global offline (acciones que fallan sin red).
- [ ] **PwaInstallBanner** — invitar a instalar la PWA (iPad recepción + móvil).
- [ ] (cosmético) `MagneticButton` / `HeroCarousel` en el landing.
- [ ] (opcional) Hero mobile dedicado en la landing.

## 5. Refactors (con red de tests)

- [ ] Archivos grandes: `ReservasHoyView.tsx` (835), `PerfilMiembroRecepcion.tsx`
      (733), `CrearReservaModal.tsx` (494), `RegistrarMiembroModal.tsx` (442).
- [ ] Constantes de rutas (`routes.ts`) en vez de paths hardcodeados.

---

## Hecho (referencia)

- **Rediseño de recepción A–F** completo (gobernanza/audit, agenda + panel Hoy +
  nueva IA, no-show manual + corregir check-in, notas + aviso, recurso fuera de
  servicio).
- **Alta de miembro reconectada** (estaba huérfana tras el rediseño de IA).
- **Logos** (logo real + tamaño unificado a 88px en member/recepción/admin).
- **Pulido visual** — ramp de tokens + transiciones premium.
- **CI** (`ci.yml`) — gate automatizado en cada push/PR.
- **DECISIONS.md + BACKLOG.md** (este ordenamiento).
- Análisis internos en `docs/audit/` (recepción + comparativa de madurez vs SALA).
