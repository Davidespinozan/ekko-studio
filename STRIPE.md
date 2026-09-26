# Conectar Stripe (membresías del miembro)

D4 (decidido): **suscripción mensual por tier · sin trial · self-serve +
recepción**. El **código de Stripe ya está implementado** (Checkout + webhook
robusto + Customer Portal). Lo que falta para cobrar online son **3 pasos de tu
lado** (cuenta, precios, env vars). Patrones tomados de HSC (proyecto hermano
ya en producción).

## La pieza clave: un solo punto de activación

La activación REAL de la membresía vive en **un único RPC**:
`activar_membresia(p_usuario_id, p_tier_id, p_stripe_subscription_id?,
p_stripe_customer_id?, p_periodo_fin?)`. Crea la fila en `membresias` (status
`activa`, periodo +1 mes) y pone `usuarios.status='activo'` + `membresia_tier`.
Lo llaman:

- **`reception-activar-membresia`** — recepción confirma el pago en mostrador.
  **Funciona HOY** (sin Stripe).
- **`stripe-webhook`** — al pagar online (`checkout.session.completed`).

Los **cambios posteriores** de la suscripción (renovó, falló el pago, canceló)
los materializa **`sync_membresia_stripe`**, con guardia de orden e idempotencia.

## Estado del código (HECHO)

| Pieza | Estado |
|---|---|
| `_lib/stripe.ts` (cliente + `getOrCreateCustomer` + mappers) | ✅ |
| `suscribir-membresia` → Checkout Session hosted (`{ url }`) | ✅ |
| `stripe-webhook` → firma + idempotencia + orden + dispatch a RPCs | ✅ |
| `stripe-portal` → Customer Portal (cancelar/tarjeta/facturas) | ✅ |
| Migración `stripe_webhook_events` + `cancel_at_period_end` + `last_sub_event_at` + RPC `sync_membresia_stripe` | ✅ |
| UI miembro (`MiSuscripcion`): checkout, "Gestionar suscripción", banner pago vencido | ✅ |
| Dependencia `stripe` instalada | ✅ |

Robustez incluida (lecciones de HSC):
- **Idempotencia**: dedupe por `event.id` (tabla `stripe_webhook_events`); si el
  procesamiento falla, borra el registro para que Stripe **reintente**.
- **Orden de eventos**: `last_sub_event_at` ignora eventos viejos (evita degradar
  a un miembro que paga).
- **`past_due`**: mantiene el acceso (gracia) y muestra banner "actualizá tu tarjeta".
- **`getOrCreateCustomer`**: reusa por `metadata.usuario_id` (no por email) +
  `idempotencyKey` → sin customers duplicados.

## Los 3 pasos que faltan (tu lado)

### 1. Crear la cuenta de Stripe + productos/precios
A nombre del **cliente** (su razón social, banco, RFC). Crear un **producto con
precio recurrente mensual por cada tier** (Básica, Pro). Stripe te da un
`price_...` por cada uno. Empezar en **modo test**.

### 2. Cargar `tiers.stripe_price_id`
Pegar cada `price_...` en su tier (admin o SQL). Sin esto, `suscribir-membresia`
responde `400` "plan sin precio configurado".

### 3. Env vars en Netlify
```
STRIPE_SECRET_KEY=sk_test_...        # luego sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...   # front (pago in-app con Elements)
```
(Ya existen `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.)

Y en el dashboard de Stripe: crear el **webhook endpoint** como endpoint de
**Connect** ("Listen to events on Connected accounts") apuntando a
`https://ekkostudio.app/.netlify/functions/stripe-webhook` — **el host apex, no
`www.`**: `www.ekkostudio.app` redirige 308 y Stripe NO sigue redirects (todos los
eventos se perderían en silencio). Eventos:
`account.updated`, `payment_intent.succeeded`, `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `charge.refunded` (sin él los reembolsos hechos
desde el dashboard nunca llegan: ni se registran ni se avisa al admin) y
`checkout.session.completed` (Checkout como fallback). La lista canónica vive en
`scripts/stripe-eventos.mjs` y un test exige que coincida con los `case` de
`clasificarEvento`. Su signing secret va en `STRIPE_CONNECT_WEBHOOK_SECRET`.

**Con script (recomendado):** `STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup-webhooks.mjs`
crea/sincroniza el endpoint con la URL, los eventos y el flag de Connected
accounts exactos, verifica que la URL no redirija, e imprime el `whsec_`. Para
live: `… --live`. Diagnóstico de solo lectura: `node scripts/stripe-check.mjs`
(webhook + cuentas conectadas de EKKO y quién paga sus fees).

> La cuenta Stripe de la plataforma se comparte con SALA/HSC: el webhook descarta
> (200) los eventos de cuentas conectadas que no sean de ningún estudio de EKKO y
> los objetos con `metadata.app` distinto de `ekko`.

> **Pago in-app (Elements):** el cobro ocurre en el modal propio de EKKO
> (`PaymentModal` + `crear-pago-intent`), sin redirigir. Con Elements la
> activación llega por `invoice.paid`(subscription_create) / `payment_intent.succeeded`,
> NO por `checkout.session.completed`.

> El **Customer Portal** se habilita una vez en el dashboard de Stripe
> (Settings → Billing → Customer portal): activar cancelar, cambiar método de
> pago y, si se quiere, cambio de plan.

## Probar (modo test)

1. Sin tocar nada más, con las keys de **test** cargadas: el miembro entra a
   Perfil → "Cambiar de plan" → es redirigido al Checkout de Stripe.
2. Pagar con tarjeta de prueba `4242 4242 4242 4242` (cualquier fecha/CVC).
3. Stripe redirige a `/app/perfil?suscripcion=ok` y el webhook activa la
   membresía vía `activar_membresia`.
4. "Gestionar suscripción" abre el Customer Portal.

Cuando esté validado en test → cambiar a keys **live** y `price_id` reales.

## Flujo sin Stripe (hoy)

Sin `STRIPE_SECRET_KEY`: `suscribir-membresia` y `stripe-portal` responden
`stripe_pendiente`; la UI dice "acercate a recepción". Recepción activa en
mostrador (`reception-activar-membresia`). No se finge ningún pago.

## Apple Pay y Google Pay

No requieren código: el formulario de pago es el `<PaymentElement>` y los cobros ya se
crean con `automatic_payment_methods`. Stripe muestra los botones solos **si el dominio
está registrado y verificado en la CUENTA CONECTADA del estudio** (cobros directos de
Connect: registrarlo en la plataforma no sirve; el síntoma es que Apple Pay simplemente no
aparece, sin ningún error).

```
STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-wallets-dominio.mjs            # registra y valida
STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-wallets-dominio.mjs --solo-ver  # solo diagnóstico
```

Correrlo **después** de publicar el sitio en `ekkostudio.app` (Stripe verifica el dominio
por HTTPS) y cada vez que un estudio nuevo active sus cobros. Apple Pay solo existe en
modo live. Para probarlo: iPhone con una tarjeta en Wallet, **Safari** (no el navegador
interno de Instagram/WhatsApp), llegar al pago → el botón sale arriba del formulario de
tarjeta. Tarjeta de crédito/débito (Visa, Mastercard, Amex) ya funcionan sin nada de esto.

