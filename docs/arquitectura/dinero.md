# Dinero y evidencia financiera

## Principio
Ningún éxito financiero sin evidencia durable; ninguna reversión sin su evidencia;
nada se reescribe para que cuadre. Lo no atribuible queda visible como "sin
resolver" para una persona, nunca adivinado.

## Evidencia (una tabla por naturaleza, ninguna se edita)
- `stripe_webhook_events`: todo evento recibido, con estado
  (`en_proceso | procesado | ignorado | error_reintentable | revision`), intentos y
  resumen sin PII. `claim_stripe_event` es la única puerta: un evento, una
  reclamación activa.
- `payment_events`: diario de cobros de Stripe. `invoice.paid` (suscripción),
  `payment_intent.succeeded` solo con `metadata.app = 'ekko'` (paquetes, invitados
  extra, tarjeta en mostrador), `invoice.payment_failed` (fallido, no es ingreso).
  UNIQUE por evento. Filas anteriores a 2026-09-27 sin metadata: no atribuibles.
- `ventas_mostrador`: efectivo, transferencia, terminal, cortesía (cobra 0). Una
  fila por `operation_id`; snapshot del precio aplicado.
- `reversales_pago`: un Refund (`re_`) o Dispute (`dp_`) = una fila, monto exacto,
  inmutable salvo el estado del proveedor; origen (`pago_origen_id`) solo si se
  demuestra.
- `invitados_extra_pagos` (+ `invitados_extra_traslados`): un PaymentIntent de
  extras → a lo más una aplicación; el traslado por reprogramación es fila nueva.
- `membresia_movimientos`: ledger de créditos (alta, débito, devolución, ajuste,
  no_show) con `origen` desde 01G; histórico `desconocido`. Trigger `ledger_inmutable`.
- `revisiones_financieras`: trabajo humano pendiente (reembolso, disputa, origen no
  resuelto, extras no aplicados, crédito no restaurado, extras en reserva
  cancelada…). `resolver_revision_financiera` documenta; no muta nada.
- `stripe_operaciones_suscripcion`: operaciones de cobro que EKKO pide a Stripe
  (ver membresia.md).

## Lectura canónica: `v_libro_economico` (RPC `libro_economico`, solo admin)
Compone las tablas anteriores sin copiar dinero. BRUTO = cobros firmes, una vez
(un PI de invitados extra se cuenta en `payment_events`, no dos veces; el PI de una
factura ya contada se excluye). REVERSADO = reembolso `succeeded` o disputa `lost`,
exacto, solo con origen firme. NETO = suma de efectos. `sin_resolver` = fuera del
neto. Fecha del proveedor, moneda en minúsculas. No conoce comisiones de Stripe.
Los reportes del admin (`src/admin/logic/reportesCobrado.ts`, dashboard) leen de
aquí. El MRR es otra cosa: ingreso contratado, desde `membresias` y precios vigentes.

## Flujo del webhook (`netlify/functions/stripe-webhook`, `_lib/stripe.ts`)
Verificar firma → `claim_stripe_event` → clasificar (`clasificarEvento`: filtra
cuenta ajena y app ajena) → ejecutar el efecto (activar, sync, reversal, extras) →
diario `payment_events` → finalizar el evento → avisos. Un fallo transitorio deja
`error_reintentable` (Stripe reintenta); uno permanente deja `revision` y avisa al
admin. Nada se borra.

## Qué NO hace este dominio
No decide derechos: un reembolso o disputa jamás cambia créditos, membresía,
cuenta ni reservas por sí solo; abre revisión. No reembolsa automáticamente
cancelaciones ni extras. No repara contadores: una inconsistencia se vuelve
evidencia + revisión.

## Decisiones que gobiernan lo ambiguo
Índice → "Dinero y evidencia financiera": EKKO-112/113/114/115, 126, 108/109,
117, 127, 134, 044, 049, 084. Y "Stripe y cobro": EKKO-105/106/107, 102, 019/043.

## Pruebas
`src/__tests__/db/{reversales,ventas-mostrador,invitados,r2b-libro-economico,
stripe-eventos,membresias-dinero}.db.test.ts`; webhook en `src/__tests__/stripe-*.test.ts`.
