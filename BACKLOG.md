# Backlog — EKKO Studio

Lista viva de pendientes. Marcá `[x]` lo hecho. Orden = prioridad sugerida.
El detalle de decisiones está en `DECISIONS.md`; la arquitectura en `KERNEL.md`.

---

## 1. Pagos / Stripe — andamiaje HECHO, falta conectar la llave

> D4 decidido (suscripción mensual por tier · sin trial · self-serve +
> recepción). El andamiaje plug-and-play ya está; ver `STRIPE.md`.

- [x] **D4 definido.**
- [x] RPC keystone `activar_membresia` (escribe `membresias` + `status='activo'`).
      **B3 cerrado.**
- [x] `reception-activar-membresia` + botón "Activar membresía" en el perfil
      (cobro en mostrador — funciona HOY).
- [x] `suscribir-membresia` (self-serve → `stripe_pendiente` sin Stripe).
- [x] `stripe-webhook` esqueleto + `checkout.ts` + `STRIPE.md` + `TODO STRIPE`.
- [ ] **Conectar Stripe** (cuando David quiera cobrar online): env vars +
      Checkout Session + activar en el webhook. Son los 3 pasos de `STRIPE.md`.
- [ ] Cargar `tiers.stripe_price_id` por plan.
- [ ] Migrar la UI del miembro (`MiSuscripcion`) de `change-plan` a
      `iniciarCheckout` cuando se conecte Stripe.
- [ ] Touchpoints que se "encienden": Método de pago, Historial de pagos.

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
