-- ============================================================================
-- RP-1 — Validación de seguridad de los RPCs (Recepción Plus)
-- ============================================================================
-- Cómo usar: aplicá primero la migración 20260520100000_recepcion_plus_rp1.sql.
-- Después pegá este script en el SQL editor de Supabase (EKKO, no SALA),
-- bloque por bloque, reemplazando los UUID de las cuentas de prueba.
--
-- No es un test automatizado: los RPCs dependen de auth.uid() (rol del
-- llamante), así que se simula la sesión con `set local request.jwt.claims`.
-- Cada bloque dice el resultado ESPERADO. Si algún ❌ devuelve OK, hay un
-- agujero de seguridad — frená y revisá.
--
-- Cuentas de prueba necesarias (1 por rol, todas del MISMO tenant):
--   :auth_recepcion  → auth.users.id de una cuenta rol='recepcionista'
--   :auth_miembro    → auth.users.id de una cuenta rol='miembro' activa
--   :auth_otro_tenant→ auth.users.id de un miembro de OTRO tenant
--   :usuario_activo  → usuarios.id de un miembro status='activo'
--   :usuario_susp    → usuarios.id de un miembro status='suspendido'
--   :recurso_id      → recursos.id activo del tenant
-- ============================================================================

-- Helper de simulación de sesión:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<auth.users.id>"}';
-- Correr cada bloque dentro de su propia transacción (BEGIN/ROLLBACK) para
-- no dejar reservas de prueba en la base.

-- ----------------------------------------------------------------------------
-- reservar_para_miembro_atomic
-- ----------------------------------------------------------------------------

-- ✅ CASO 1 — recepción reserva para un miembro activo → debe crear la reserva
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_recepcion"}';
  SELECT reservar_para_miembro_atomic(
    'REEMPLAZAR_usuario_activo'::uuid,
    'REEMPLAZAR_recurso_id'::uuid,
    now() + interval '2 hours',   -- dentro de la ventana: D1 lo permite igual
    60, 0, 'check RP-1 caso 1'
  );  -- ESPERADO: jsonb { success: true, reserva_id, folio }
ROLLBACK;

-- ❌ CASO 2 — un miembro llama el RPC → EKKO_NO_AUTORIZADO
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_miembro"}';
  SELECT reservar_para_miembro_atomic(
    'REEMPLAZAR_usuario_activo'::uuid,
    'REEMPLAZAR_recurso_id'::uuid,
    now() + interval '2 days', 60, 0, NULL
  );  -- ESPERADO: ERROR EKKO_NO_AUTORIZADO
ROLLBACK;

-- ❌ CASO 3 — recepción reserva para un miembro de OTRO tenant
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_recepcion"}';
  -- usar como usuario objetivo un usuarios.id de otro tenant:
  SELECT reservar_para_miembro_atomic(
    (SELECT id FROM usuarios WHERE auth_id = 'REEMPLAZAR_auth_otro_tenant'::uuid),
    'REEMPLAZAR_recurso_id'::uuid,
    now() + interval '2 days', 60, 0, NULL
  );  -- ESPERADO: ERROR EKKO_MIEMBRO_INVALIDO
ROLLBACK;

-- ❌ CASO 4 — recepción reserva para un miembro suspendido (D2)
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_recepcion"}';
  SELECT reservar_para_miembro_atomic(
    'REEMPLAZAR_usuario_susp'::uuid,
    'REEMPLAZAR_recurso_id'::uuid,
    now() + interval '2 days', 60, 0, NULL
  );  -- ESPERADO: ERROR EKKO_MIEMBRO_NO_ACTIVO
ROLLBACK;

-- ✅ CASO 5 — walk-in: slot dentro de min_anticipacion_horas → D1 lo permite
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_recepcion"}';
  SELECT reservar_para_miembro_atomic(
    'REEMPLAZAR_usuario_activo'::uuid,
    'REEMPLAZAR_recurso_id'::uuid,
    now() + interval '30 minutes',  -- mucho menos que las 24h por defecto
    60, 0, 'walk-in'
  );  -- ESPERADO: success true (NO error de anticipación)
ROLLBACK;

-- ----------------------------------------------------------------------------
-- cancelar_reserva_atomic
-- ----------------------------------------------------------------------------
-- Para estos casos necesitás :reserva_de_miembro = una reserva 'confirmada'
-- futura cuyo usuario_id sea el miembro de prueba.

-- ✅ CASO 6 — recepción cancela la reserva de un miembro
--   → status='cancelada_admin', cancelada_por seteado, notificación creada
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_recepcion"}';
  SELECT status, cancelada_por FROM cancelar_reserva_atomic(
    'REEMPLAZAR_reserva_de_miembro'::uuid, 'check RP-1 caso 6'
  );  -- ESPERADO: status='cancelada_admin', cancelada_por = id del recepcionista
  -- verificar la notificación:
  -- SELECT * FROM notificaciones WHERE tipo='reserva_cancelada'
  --   ORDER BY creada_at DESC LIMIT 1;  → mensaje "...por el estudio"
ROLLBACK;

-- ✅ CASO 7 — el propio miembro cancela su reserva → status='cancelada'
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_miembro"}';
  SELECT status FROM cancelar_reserva_atomic(
    'REEMPLAZAR_reserva_de_miembro'::uuid, NULL
  );  -- ESPERADO: status='cancelada' (NO cancelada_admin, sin notificación)
ROLLBACK;

-- ❌ CASO 8 — un miembro intenta cancelar la reserva de OTRO miembro
BEGIN;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"REEMPLAZAR_auth_miembro"}';
  SELECT cancelar_reserva_atomic(
    'REEMPLAZAR_reserva_de_OTRO_miembro'::uuid, NULL
  );  -- ESPERADO: ERROR EKKO_NO_AUTORIZADO
ROLLBACK;

-- ----------------------------------------------------------------------------
-- Lo prohibido sigue prohibido (regresión)
-- ----------------------------------------------------------------------------
-- Verificar manualmente que NO cambió nada:
--  - reception-create-member: cubierto por src/__tests__/reception-create-member.test.ts
--  - admin-create-user / admin-delete-user siguen devolviendo 403 a recepción.
--  - RLS de membresias / payment_events / tiers / tenants intacta (is_admin()).
--  - Recepción que abra /admin/* sigue rebotada por el guard de AdminLayout.
