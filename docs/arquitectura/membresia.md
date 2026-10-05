# Membresía, derecho y cobro recurrente

## Autoridad
- El derecho de un miembro es su membresía VIVA en `membresias` (status
  `trialing`, `activa`, `past_due`; `pausada` cuenta como viva para devolver
  créditos). `usuarios.membresia_tier` y `membresia_activa_id` son CACHÉ de
  display; las RPC resuelven el plan con `_tier_vivo(usuario)`.
- Planes en `tiers`: `tipo` `tiempo` (mensual), `creditos` (paquete) o `hibrido`
  (paquete con vigencia). `reglas.max_invitados` obligatorio. Slug inmutable; tipo y
  "activo" no cambian con membresías vivas (`tiers_proteger_semantica`).

## Primitivas (una por transición; todas SECURITY DEFINER, idempotentes)
- `activar_membresia`: único punto de alta/renovación. Idempotente por suscripción
  de Stripe o por `referencia_pago`. La llaman el webhook (evento financiero) y
  `registrar_venta_mostrador`. Un Checkout creado no da derecho: lo da `invoice.paid`
  o `payment_intent.succeeded`.
- `sync_membresia_stripe`: refleja el estado de la suscripción. Nunca resucita una
  membresía terminal (`cancelada`, `expirada`) ni saca a nadie de `revocado`.
- `cambiar_tier_membresia` (+ `reservas_incompatibles_con_tier`): cambio de plan
  atómico; reservas futuras incompatibles BLOQUEAN el cambio.
- `staff_cancelar_membresia`, `staff_pausar_membresia`, `staff_ajustar_creditos`,
  `expirar_membresias_vencidas` (cron diario, solo paquetes sin Stripe).
- Créditos: `creditos_debitar_al_reservar` (AFTER INSERT de reserva; exige
  membresía viva) y `creditos_devolver_al_cancelar` escriben `membresia_movimientos`
  (ledger inmutable, con `origen`). La devolución va a la membresía que pagó; sin
  destino válido abre una revisión, nunca pierde el crédito en silencio.

## Terminación y acceso
- Baja, expiración, sanción y revocación NO cancelan reservas futuras. La puerta
  decide: `_estado_membresia_checkin` evalúa revocación y sanción primero, luego
  "sesión ya pagada con crédito" (entra), luego cuenta y membresía. QR rechaza
  todo lo que no sea `ok`; el check-in manual puede hacer override auditado salvo
  revocación.
- No se reserva una sesión posterior al fin efectivo conocido de un plan por tiempo
  (`reservas_dentro_de_vigencia`). Una falta que EKKO hizo imposible no se penaliza.
- Revocación persistente: solo `restaurar_acceso_revocado` la levanta.

## Cobro en Stripe desde EKKO
- Lo que EKKO debe hacer en Stripe queda en `stripe_operaciones_suscripcion`,
  creado por trigger en la misma transacción: sanción → `suspender_cobro`
  (pause_collection), levantar sanción → `reanudar_cobro` solo si todo sigue
  válido, revocación o baja inmediata → `cancelar_suscripcion` ya. El ejecutor
  (`netlify/functions/_lib/operacionesSuscripcion.ts`) revalida con
  `operacion_suscripcion_preparar`, llama a Stripe con llave por intento y asienta
  `operacion_suscripcion_resultado`. Si Stripe falla, EKKO no se deshace: la
  operación queda `fallida`, avisa al admin y la reintenta el cron o
  `staff-sincronizar-cobro`. Nunca hay reembolso automático.
- Otras funciones de Stripe del lado del miembro: `suscribir-membresia`,
  `crear-pago-intent`, `cambiar-plan-suscripcion`, `stripe-pausar-membresia`,
  `stripe-cancelar-suscripcion`, `stripe-portal`; idempotencia saliente en
  `_lib/operacionPago.ts`.

## Invariantes
Sin derecho sin evidencia financiera. Un evento → un efecto. Stripe informa el
estado de la suscripción, no la sanción. Un cobro no levanta una sanción.

## Decisiones que gobiernan lo ambiguo
Índice → "Membresía y derecho" (EKKO-123, 100/101, 098/099, 110, 125, 127, 128,
057) y "Stripe y cobro" (EKKO-129/130/131, 105/106/107, 102).

## Fuera de este dominio
Transiciones de la reserva (reservas.md); evidencia de dinero y revisiones (dinero.md).
