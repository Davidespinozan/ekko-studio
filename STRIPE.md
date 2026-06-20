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
```
(Ya existen `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.)

Y en el dashboard de Stripe: apuntar el **webhook endpoint** a
`/.netlify/functions/stripe-webhook` con los eventos:
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`.

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
