-- ============================================================================
-- SCHEMA DRIFT CHECK · Fase 1 identidad (2026-09-25) · SOLO LECTURA
-- Pegar en el SQL editor de producción ANTES de decidir el plan de migraciones.
-- Cada bloque devuelve filas `objeto · esperado_por · presente`. Lo que debe
-- existir ANTES de 20260925100000 se marca como prerrequisito.
-- No modifica nada.
-- ============================================================================

-- 0. Historial de migraciones que Supabase cree aplicadas (para comparar con el repo)
SELECT 'migracion_remota' AS objeto, version, name FROM supabase_migrations.schema_migrations ORDER BY version;

-- 1. Columnas de usuarios
WITH esperadas(col, origen) AS (VALUES
  ('auth_id','20260514100200'), ('email','20260514100200'), ('membresia_tier','20260514100200'),
  ('membresia_activa_id','20260514100400'), ('notas_admin','20260514150000'), ('invitado','20260517500000'),
  ('identidad_completa','20260620170000'), ('contrato_firmado','20260620170000'), ('contrato_firmado_at','20260620170000'),
  ('sancionado_at','20260925100000 (NUEVA)'), ('sancion_motivo','20260925100000 (NUEVA)'),
  ('stripe_customer_id','DEBE NO EXISTIR (20260521100000 la quitó)'), ('ob_data','DEBE NO EXISTIR (20260521100000)'))
SELECT 'usuarios.' || e.col AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='usuarios' AND c.column_name=e.col) AS presente
FROM esperadas e;

-- 2. Columnas de membresias y datos privados
WITH esperadas(tabla, col, origen) AS (VALUES
  ('membresias','stripe_customer_id','20260514100400'), ('membresias','stripe_subscription_id','20260514100400'),
  ('membresias','creditos_restantes','20260620150000'), ('membresias','cancel_at_period_end','20260620120000'),
  ('membresias','aviso_vencimiento_at','20260821180000 (pendiente)'), ('membresias','pausada_at','20260821200000 (pendiente)'),
  ('membresias','referencia_pago','20260920150000 (pendiente)'), ('membresias','pausada_desde_status','20260920160000 (pendiente)'),
  ('usuarios_datos_privados','stripe_customer_id','20260521100000'), ('usuarios_datos_privados','fecha_nacimiento','20260620170000'),
  ('usuarios_datos_privados','domicilio','20260620170000'), ('usuarios_datos_privados','ine_foto_path','20260620170000'),
  ('notificaciones','push_enviado_at','20260821210000 (pendiente)'), ('notificaciones','email_enviado_at','20260920210000 (pendiente)'),
  ('tiers','en_venta','20260821180000 (pendiente; el front lo necesita)'))
SELECT e.tabla || '.' || e.col AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=e.tabla AND c.column_name=e.col) AS presente
FROM esperadas e;

-- 3. Constraints e índices relevantes
WITH esperados(nombre, origen) AS (VALUES
  ('usuarios_tenant_id_email_key','20260514100200 UNIQUE(tenant_id,email)'), ('usuarios_auth_id_key','20260514100200'),
  ('usuarios_email_lower_idx','20260514100200 (no único)'), ('usuarios_tenant_email_lower_uniq','20260925110000 (NUEVA, condicional)'),
  ('membresias_one_active_per_user','20260514100400 / redefinido 20260920150000'), ('membresias_referencia_pago_uniq','20260920150000 (pendiente)'),
  ('reservas_recordatorio_pendiente_idx','20260921110000 (pendiente)'))
SELECT e.nombre AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname='public' AND i.indexname=e.nombre) AS presente
FROM esperados e;

SELECT 'membresias_status_check' AS objeto, pg_get_constraintdef(oid) AS definicion,
       pg_get_constraintdef(oid) LIKE '%pausada%' AS incluye_pausada_(20260821200000)
FROM pg_constraint WHERE conname = 'membresias_status_check';

SELECT 'usuarios_status_check' AS objeto, pg_get_constraintdef(oid) AS definicion,
       pg_get_constraintdef(oid) LIKE '%revocado%' AS incluye_revocado_(20260522100000)
FROM pg_constraint WHERE conname = 'usuarios_status_check';

-- 4. Triggers
WITH esperados(tabla, trg, origen) AS (VALUES
  ('auth.users','on_auth_user_created','20260514101000 (20260925100000 lo redefine)'),
  ('auth.users','on_auth_user_email_changed','20260705120000'),
  ('usuarios','trg_proteger_columnas_usuarios','20260521100000 (función redefinida 20260921100000 y 20260925100000)'),
  ('usuarios','trg_no_borrar_ultimo_admin','20260921100000 (pendiente)'),
  ('usuarios','trg_sancion_manda','20260925100000 (NUEVA)'),
  ('usuarios','trg_identidad_por_avatar','20260925100000 (NUEVA)'),
  ('usuarios_datos_privados','trg_dp_recalcular_identidad','20260925100000 (NUEVA)'),
  ('usuarios','cancelar_membresia_al_quitar_plan_trg','20260703170000'),
  ('reservas','trg_exigir_identidad_ingreso','20260620170000'),
  ('reservas','trg_creditos_debitar','20260920110000 (pendiente)'),
  ('reservas','trg_reserva_exige_membresia_viva','20260920110000 (pendiente; verificar nombre real)'),
  ('membresia_movimientos','trg_ledger_inmutable','20260921100000 (pendiente)'))
SELECT e.tabla || ' · ' || e.trg AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE t.tgname = e.trg AND (n.nspname || '.' || c.relname) = CASE WHEN e.tabla LIKE 'auth.%' THEN e.tabla ELSE 'public.' || e.tabla END) AS presente
FROM esperados e;

-- 5. Funciones / RPC (nombre + argumentos)
WITH esperadas(fn, origen) AS (VALUES
  ('handle_new_auth_user()','20260514101000'), ('handle_auth_user_email_change()','20260705120000'),
  ('proteger_columnas_privilegiadas_usuarios()','20260620170000'), ('is_admin()','20260514100700'),
  ('count_admins_activos(uuid)','PRERREQUISITO 20260821160000 (la versión 20260925100000 del trigger la llama)'),
  ('count_active_admins(uuid)','20260514130000'),
  ('activar_membresia(uuid,uuid,text,text,timestamptz,text,boolean)','20260920150000 (pendiente; firma nueva)'),
  ('activar_membresia(uuid,uuid,text,text,timestamptz)','firma VIEJA (20260704170000): debe desaparecer al aplicar 20260920150000'),
  ('sync_membresia_stripe(text,text,timestamptz,boolean,timestamptz)','20260620120000 / redefinida 20260821200000, 20260920100000'),
  ('staff_pausar_membresia(uuid,boolean,text)','20260821200000 (pendiente)'),
  ('staff_cancelar_membresia(uuid,boolean,text)','20260920180000 (pendiente)'),
  ('slots_ocupados(uuid,timestamptz,timestamptz)','20260920200000 (pendiente; el front de Reservar lo llama)'),
  ('calcular_identidad_completa(text,uuid)','20260925100000 (NUEVA)'),
  ('usuarios_sancion_manda()','20260925100000 (NUEVA)'),
  ('dev_activar_miembro(text,text)','DEBE NO EXISTIR (purga 20260521100000)'))
SELECT e.fn AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname='public' AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = e.fn
                  OR (n.nspname='public' AND p.proname || '(' || replace(pg_get_function_identity_arguments(p.oid), ' ', '') || ')' = e.fn)) AS presente
FROM esperadas e;

-- 5b. Cuerpo vigente del trigger de alta (para ver si ya vincula o sigue en DO NOTHING)
SELECT 'handle_new_auth_user · vincula' AS objeto,
       position('EKKO_IDENTIDAD_AMBIGUA' IN prosrc) > 0 AS ya_es_version_20260925,
       position('DO NOTHING' IN prosrc) > 0 AS sigue_en_do_nothing
FROM pg_proc WHERE proname = 'handle_new_auth_user';

-- 5c. ¿is_admin exige status='activo'? (20260920130000, pendiente)
SELECT 'is_admin · exige activo' AS objeto, position('activo' IN prosrc) > 0 AS presente FROM pg_proc WHERE proname = 'is_admin';

-- 6. Policies RLS relevantes
WITH esperadas(tabla, pol, origen) AS (VALUES
  ('usuarios','usuarios_read_self','20260514100800'), ('usuarios','usuarios_read_admin','20260514100800'),
  ('usuarios','usuarios_update_self','20260514100800'), ('usuarios','usuarios_update_admin','20260514100800'),
  ('usuarios','usuarios_insert_admin','20260514100800 (permite filas sin auth_id)'),
  ('usuarios_datos_privados','udp_select_self','20260521100000'), ('usuarios_datos_privados','udp_admin_all','20260521100000'),
  ('membresias','membresias_read_staff','20260821170000 (pendiente)'),
  ('material_sesion','material_read_self','20260920220000 (pendiente)'))
SELECT e.tabla || ' · ' || e.pol AS objeto, e.origen AS esperado_por,
       EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=e.tabla AND p.policyname=e.pol) AS presente
FROM esperadas e;

-- 7. Tablas que las migraciones pendientes crean
SELECT 'tabla ' || t AS objeto, o AS esperado_por,
       EXISTS (SELECT 1 FROM information_schema.tables x WHERE x.table_schema='public' AND x.table_name=t) AS presente
FROM (VALUES ('material_sesion','20260920220000 (pendiente)'), ('stripe_webhook_events','20260620120000'),
             ('reserva_invitados','20260704210000'), ('audit_log','20260611100000 (PRERREQUISITO: el trigger de alta inserta ahí)')) v(t,o);
