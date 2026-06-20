# Conectar Stripe (membresías del miembro)

D4 (decidido): **suscripción mensual por tier · sin trial · self-serve +
recepción**. El flujo está **cableado plug-and-play**: conectar Stripe real es
completar 3 puntos, sin tocar UI ni la lógica de activación.

## La pieza clave: un solo punto de activación

La activación REAL de la membresía vive en **un único RPC**:
`activar_membresia(p_usuario_id, p_tier_id, p_stripe_subscription_id?,
p_stripe_customer_id?, p_periodo_fin?)` (`SECURITY DEFINER`, solo `service_role`).
Crea la fila en `membresias` (status `activa`, periodo +1 mes) y pone
`usuarios.status='activo'` + `membresia_tier`. Lo llaman:

- **`reception-activar-membresia`** — recepción confirma el pago en mostrador y
  activa. **Funciona HOY** (sin Stripe). Es el canal "+recepción" de D4.
- **`stripe-webhook`** — cuando Stripe esté conectado, materializa el pago.
- **`suscribir-membresia`** — el atajo simulado, si se habilita.

Como todo pasa por el mismo RPC, **cierra B3** (cambiar/activar plan deja la
cuenta consistente, ya no queda inerte).

## Cómo funciona hoy (sin Stripe)

1. El miembro elige un plan → `iniciarCheckout(tierSlug)`
   (`src/shared/lib/checkout.ts`) → function **`suscribir-membresia`**.
2. Sin `STRIPE_SECRET_KEY` → `{ activated: false, reason: 'stripe_pendiente' }`.
   La UI muestra "pago en camino — acercate a recepción". **No cobra ni activa**
   (no fingimos pago).
3. Recepción activa en mostrador: perfil del miembro → **"Activar membresía"** →
   `reception-activar-membresia` → `activar_membresia`.

## Los 3 pasos para conectar Stripe

### 1. Env vars (Netlify)
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```
(Ya existen `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.)

### 2. `netlify/functions/suscribir-membresia` → crear Checkout Session
Reemplazar el bloque `[TODO STRIPE]`: en vez de `stripe_pendiente`, crear
`stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price:
tier.stripe_price_id, quantity: 1 }], metadata: { usuario_id, tier_id }, ... })`
y devolver `{ url: session.url }`. `iniciarCheckout` ya redirige si viene `url`.

### 3. `netlify/functions/stripe-webhook` → activar al pagar
Completar los 2 `[TODO STRIPE]`:
- Verificar firma con `stripe.webhooks.constructEvent`.
- `checkout.session.completed` / `customer.subscription.updated` →
  `activar_membresia(usuario_id, tier_id, subscription_id, customer_id,
  current_period_end)` (IDs del `metadata`/objeto).
- `customer.subscription.deleted` → marcar la membresía `cancelada`.

### Datos a cargar
- `tiers.stripe_price_id` por cada plan (columna ya existe).
- Apuntar el endpoint del webhook en Stripe a `/.netlify/functions/stripe-webhook`.

## Touchpoints en la UI (greppables: `TODO STRIPE`)

| Lugar | Hoy | Al conectar Stripe |
|---|---|---|
| Miembro → comprar/cambiar plan | `iniciarCheckout` → "pago en camino" | Redirige al Checkout |
| Perfil de recepción → "Activar membresía" | activa en mostrador (RPC) | sigue funcionando (pago en persona) |
| `suscribir-membresia` | `stripe_pendiente` | crear Checkout Session |
| `stripe-webhook` | inerte (sin secret) | verificar firma + activar/cancelar |
| Método de pago / Historial de pagos (miembro) | placeholders | Customer Portal / `payment_events` |
