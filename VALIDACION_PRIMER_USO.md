# Validación en el primer uso real · Fase 1

Fase 1 quedó **cerrada en producción de forma condicional** el 2026-09-26.
Cuatro capacidades no se probaron en vivo, porque hacerlo exigía un cargo real
o credenciales de personas. Se validan observando su **primera operación real**.
Si cualquiera falla, se reabre el bloque de Fase 1 correspondiente.
Fase 2 no borra ni oculta estas validaciones.

Las consultas son de solo lectura (SQL editor de Supabase o
`supabase db query --linked`). Cambia `<correo>` por el del caso real.

## 1. Primer pago real (pago → membresía)

- [ ] El miembro se registra desde la landing y queda en `pendiente_pago` con el plan elegido.
- [ ] Paga desde la app (PagarMembresia) y Stripe confirma el cobro.
- [ ] El webhook lo registra una sola vez y queda procesado:
  ```sql
  SELECT id, type, processed_at FROM stripe_webhook_events ORDER BY received_at DESC LIMIT 5;
  ```
- [ ] Hay exactamente una membresía viva, con referencia de pago y el plan correcto:
  ```sql
  SELECT m.status, t.slug, m.creditos_restantes, m.referencia_pago, m.stripe_customer_id IS NOT NULL AS con_customer
  FROM membresias m JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = (SELECT id FROM usuarios WHERE email = '<correo>');
  ```
- [ ] La cuenta queda `activo`, con `membresia_tier` y `membresia_activa_id` apuntando a esa membresía.
- [ ] `payment_events` tiene la fila con `usuario_id` (no NULL).
- [ ] Tras cerrar sesión y volver a entrar conserva el acceso.
- [ ] Si Stripe reintenta el mismo evento, no aparece una segunda membresía.

**Reabrir si:** no se crea la membresía, se crean dos, la cuenta queda en `pendiente_pago` tras el cobro o `payment_events.usuario_id` queda NULL.

## 2. Primera operación de staff

- [ ] Recepción abre la ficha de un miembro: ve sus datos y la ficha de identidad, pero no puede editar cuentas del equipo.
- [ ] En "Editar datos" cambia solo el teléfono: nombre y correo no cambian.
- [ ] En la ficha de identidad cambia solo el domicilio: nacimiento, folio y foto de la INE se conservan.
- [ ] Sin red, la ficha muestra "Reintentar" y no deja guardar.
- [ ] Un contrato ya firmado aparece bloqueado y `contrato_firmado_at` no cambia al guardar otra cosa:
  ```sql
  SELECT contrato_firmado, contrato_firmado_at FROM usuarios WHERE email = '<correo>';
  ```
- [ ] Hay una entrada en `audit_log` por cada cambio, con el actor correcto.

**Reabrir si:** un campo omitido se borra, se puede guardar con la carga fallida, cambia la fecha de firma o recepción edita a alguien del equipo.

## 3. Primera sanción real

- [ ] Recepción suspende a un miembro con motivo. La cuenta queda con sanción:
  ```sql
  SELECT status, sancionado_at, sancion_motivo FROM usuarios WHERE email = '<correo>';
  ```
- [ ] Mientras dure la sanción, nada de esto la levanta (el status sigue `suspendido`):
  - un cobro de su suscripción (invoice.paid);
  - una activación de plan en el mostrador;
  - reanudar una pausa.
- [ ] En la app no puede comprar un plan (error "suspendida por el estudio").
- [ ] Al reactivarlo recepción con motivo, `sancionado_at` vuelve a NULL y la cuenta queda `activo`.

**Reabrir si:** una activación, un cobro o una reanudación devuelve la cuenta a `activo` con `sancionado_at` puesto.

### 3b. Reserva ya pagada + sanción o revocación (F2 · R1, cierre del P0-1)

Hasta R1, una reserva pagada con créditos antes de la sanción dejaba entrar por QR.
R1 lo cierra en código y en tests (`src/__tests__/db/r1-invariantes.db.test.ts`).
**Nada de esto se ha probado en producción**; validarlo la primera vez que ocurra.

Política final: el QR rechaza a sancionados y revocados; en mostrador, un
**revocado no entra** y un **sancionado puede entrar solo como excepción de
recepción**, con aviso y registrada en la bitácora.

**Reserva pagada con créditos → SANCIÓN**
- [ ] La app **no** le entrega el QR ("Tu cuenta está suspendida por el estudio").
- [ ] Un QR generado antes de la sanción: el escáner lo **rechaza** ("Membresía no vigente…").
- [ ] Si recepción lo deja pasar a mano: aparece el aviso "CUENTA SANCIONADA… registrado como excepción" y la bitácora registra el override:
  ```sql
  SELECT accion, despues, metadata, creada_at FROM audit_log
  WHERE target_id = (SELECT id FROM usuarios WHERE email = '<correo>')
    AND accion = 'checkin_manual_con_restriccion' ORDER BY creada_at DESC LIMIT 3;
  ```
- [ ] El crédito de esa reserva **no** se vuelve a descontar.

**Reserva pagada con créditos → REVOCACIÓN**
- [ ] La app **no** le entrega el QR ("Tu acceso fue revocado").
- [ ] Un QR generado antes: el escáner lo **rechaza**.
- [ ] El check-in **manual** también se **rechaza** ("Acceso REVOCADO… Solo un admin puede restaurar el acceso") y la reserva sigue `confirmada`, sin `check_in_at`.
- [ ] Tras restaurar el acceso (admin, con motivo), el acceso vuelve a depender de la membresía y aparece `acceso_restaurado` en la bitácora.

**Reabrir si:** un sancionado o revocado entra por QR con una reserva ya pagada, un revocado entra por mostrador, o un ingreso manual de un sancionado no queda en la bitácora.

## 4. Primera reserva de un miembro activo (después de Fase 1)

- [ ] En Reservar, las horas ocupadas por otros se ven ocupadas.
- [ ] La reserva se crea con folio y QR; en paquetes se descuenta el crédito:
  ```sql
  SELECT r.folio, r.status, r.slot_inicio FROM reservas r
  WHERE r.usuario_id = (SELECT id FROM usuarios WHERE email = '<correo>') ORDER BY r.created_at DESC LIMIT 3;
  ```
- [ ] Otra persona no puede reservar el mismo estudio a la misma hora.
- [ ] El mismo miembro no puede reservar otro set a la misma hora ("un set a la vez").
- [ ] Si cancela a tiempo, se le devuelve el crédito.
- [ ] Llega el aviso de confirmación en la app (y por correo cuando Resend esté configurado).

**Reabrir si:** aparece una doble reserva, la grilla no muestra lo ocupado o el crédito no se descuenta o no se devuelve.

## Deuda de configuración (no bloquea Fase 1)

- `RESEND_API_KEY` y `EKKO_EMAIL_FROM`: sin ellas no sale ningún correo. La app, el push y los pagos funcionan igual.
- `SENTRY_DSN`: sin él no hay reporte de errores del backend.
