-- ============================================================================
-- HARDENING — checks de privilegios y contratos (2026-08-21, paridad con SALA)
-- ============================================================================
-- Cómo usar: pegar TODO en el SQL editor de Supabase (EKKO) y ejecutar. Devuelve
-- una TABLA area · caso · resultado (✅/❌). Complementa sec_fix_checks.sql y
-- schema_drift_check.sql con lo que se endureció en el Sprint 1:
--   P1  funciones de cron/keystone NO ejecutables por authenticated/anon
--   P2  tenants: columnas stripe_* solo backend; UPDATE acotado
--   P3  storage: las policies de escritura atan el objeto al tenant
--   P4  contratos: los guards clave siguen en el cuerpo de cada función
--       (si alguien recrea una función y pierde un guard, esto lo cacha)
-- ============================================================================

DROP TABLE IF EXISTS _hardening_resultado;
CREATE TEMP TABLE _hardening_resultado (
  id serial PRIMARY KEY,
  area text,
  caso text,
  resultado text
);

-- ── P1: denylist de ejecución ────────────────────────────────────────────────
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'expirar_membresias_vencidas()',
    'marcar_no_shows()',
    'generar_recordatorios_reservas()',
    'sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz)',
    -- PKG-01H: reemplazan a registrar_invitados_extra_pagados (ver abajo).
    'aplicar_invitados_extra_pago(text, text, uuid, text, uuid, uuid, integer, integer, integer, text, timestamptz, uuid)',
    'registrar_ficha_invitado(uuid, uuid, text, text)'
  ] LOOP
    BEGIN
      INSERT INTO _hardening_resultado (area, caso, resultado) VALUES
        ('P1', f || ' solo service_role',
         CASE WHEN NOT has_function_privilege('authenticated', f, 'EXECUTE')
                   AND NOT has_function_privilege('anon', f, 'EXECUTE')
                   AND has_function_privilege('service_role', f, 'EXECUTE')
              THEN '✅ PASS' ELSE '❌ FAIL — permisos incorrectos' END);
    EXCEPTION WHEN undefined_function THEN
      INSERT INTO _hardening_resultado (area, caso, resultado) VALUES ('P1', f, '⏭ no existe con esa firma');
    END;
  END LOOP;
END $$;

-- PKG-01H: la firma vieja (sumaba sin llave por PaymentIntent) no la ejecuta
-- NADIE de la app, ni service_role. Existe (sin DROP) pero está revocada.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P1', 'registrar_invitados_extra_pagados(uuid, integer) revocada para todos',
  CASE WHEN NOT has_function_privilege('authenticated', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
            AND NOT has_function_privilege('anon', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
            AND NOT has_function_privilege('service_role', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
       THEN '✅ PASS' ELSE '❌ FAIL — la firma vieja sigue ejecutable' END;

-- ── P2: tenants por columnas ─────────────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P2', 'anon/authenticated NO leen stripe_*',
  CASE WHEN NOT has_column_privilege('anon', 'tenants', 'stripe_account_id', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_account_id', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_subscription_product_id', 'SELECT')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'authenticated NO actualiza stripe_*/slug/status',
  CASE WHEN NOT has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'UPDATE')
            AND NOT has_column_privilege('authenticated', 'tenants', 'slug', 'UPDATE')
            AND NOT has_column_privilege('authenticated', 'tenants', 'status', 'UPDATE')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'público sigue leyendo nombre/config/branding y admin edita config',
  CASE WHEN has_column_privilege('anon', 'tenants', 'nombre', 'SELECT')
            AND has_column_privilege('authenticated', 'tenants', 'config', 'SELECT')
            AND has_column_privilege('authenticated', 'tenants', 'branding', 'UPDATE')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'radar: ninguna columna nueva de tenants fuera de la lista conocida',
  CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenants'
           AND column_name NOT IN (
             'id','slug','nombre','vertical','branding','config','dominio_principal','dominio_app',
             'status','created_at','updated_at',
             'stripe_account_id','stripe_subscription_product_id','stripe_charges_enabled','stripe_details_submitted',
             'stripe_desconectado_at' -- PKG-01G: privada (solo service_role), como el resto de stripe_*
           )
       ) THEN '✅ PASS' ELSE '⚠️ REVISAR — hay columnas nuevas: decidir si son públicas (GRANT) o privadas' END;

-- ── P3: storage con scope de tenant ──────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P3', policyname || ' ata path + tenant',
  CASE WHEN position('foldername' in coalesce(qual, with_check)) > 0
            AND position('get_my_tenant_id' in coalesce(qual, with_check)) > 0
       THEN '✅ PASS' ELSE '❌ FAIL' END
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN (
    'Estudios admin upload','Estudios admin update','Estudios admin delete',
    'Logos admin upload','Logos admin update','Logos admin delete',
    'avatars_admin_write','avatars_admin_update','avatars_admin_delete'
  );

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P3', 'existen las 9 policies de escritura',
  CASE WHEN count(*) = 9 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || count(*) END
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN (
    'Estudios admin upload','Estudios admin update','Estudios admin delete',
    'Logos admin upload','Logos admin update','Logos admin delete',
    'avatars_admin_write','avatars_admin_update','avatars_admin_delete'
  );

-- ── P4: contratos (guards que no pueden perderse al recrear funciones) ───────
CREATE OR REPLACE FUNCTION pg_temp._fn_contiene(p_fn text, p_frag text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(position(p_frag in (
    SELECT prosrc FROM pg_proc WHERE proname = p_fn AND pronamespace = 'public'::regnamespace LIMIT 1
  )) > 0, false);
$$;

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', fn || ' contiene ' || frag,
  CASE WHEN pg_temp._fn_contiene(fn, frag) THEN '✅ PASS' ELSE '❌ FAIL — guard perdido' END
FROM (VALUES
  ('cancelar_reserva_atomic',      'EKKO_TENANT_DIFERENTE'),
  ('check_in_atomic',              'EKKO_TENANT_DIFERENTE'),
  ('check_in_manual_atomic',       'EKKO_TENANT_DIFERENTE'),
  ('reservar_recurso_atomic',      '_recurso_permite_tier'),
  ('reservar_recurso_atomic',      'FOR UPDATE'),
  ('reservar_recurso_atomic',      'EKKO_LIMITE_DIARIO'),
  ('reservar_para_miembro_atomic', '_recurso_permite_tier'),
  ('reservar_para_miembro_atomic', 'EKKO_NO_AUTORIZADO'),
  ('marcar_no_shows',              'no_show_bloqueo_dias'),
  ('creditos_devolver_al_cancelar','cancelacion_tardia'),
  ('count_active_admins',          'get_my_tenant_id'),
  ('count_admins_activos',         'get_my_tenant_id'),
  ('count_reservas_recurso',       'get_my_tenant_id'),
  ('count_miembros_tier',          'get_my_tenant_id'),
  ('recursos_validar_tiers_permitidos', 'EKKO_TIER_PERMITIDO_INVALIDO')
) AS c(fn, frag);

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'creditos_devolver_al_cancelar NO decide con anticipacion_min_horas',
  CASE WHEN NOT pg_temp._fn_contiene('creditos_devolver_al_cancelar', 'anticipacion_min_horas')
       THEN '✅ PASS' ELSE '❌ FAIL' END;

-- ── P5: frontera por REST (PKG-02C) ──────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'ninguna policy decide por rol crudo sin estado activo',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
         AND (coalesce(qual,'')||coalesce(with_check,'')) ~ 'usuarios\.rol'
         AND (coalesce(qual,'')||coalesce(with_check,'')) !~ 'status')
       THEN '✅ PASS' ELSE '❌ FAIL — policy con rol sin status' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'ninguna policy UPDATE/ALL sin WITH CHECK',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND cmd IN ('UPDATE','ALL') AND with_check IS NULL)
       THEN '✅ PASS' ELSE '❌ FAIL — UPDATE sin WITH CHECK' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin INSERT/UPDATE/DELETE/TRUNCATE en public',
  CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema='public' AND grantee='anon' AND privilege_type <> 'SELECT')
       THEN '✅ PASS' ELSE '❌ FAIL — anon con escritura' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin EXECUTE en funciones de aplicación',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.objid=p.oid AND d.deptype='e'))
       THEN '✅ PASS' ELSE '❌ FAIL — anon ejecuta funciones' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'authenticated sin DML donde ninguna policy escribe, y sin TRUNCATE',
  CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
         WHERE g.table_schema='public' AND g.grantee='authenticated'
           AND (g.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER')
                OR (g.privilege_type IN ('INSERT','UPDATE','DELETE')
                    AND g.table_name NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public' AND cmd<>'SELECT'))))
       THEN '✅ PASS' ELSE '❌ FAIL — grant sin policy' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'gate cambiar_password: trigger en auth.users y frontera de avisos presentes',
  CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_password_changed')
         AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notificaciones_frontera_cliente')
         AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notas_miembro_autor_servidor')
       THEN '✅ PASS' ELSE '❌ FAIL — falta trigger' END;

-- F-1 (20261008100000): una vista se evalúa con los permisos de su dueño salvo
-- `security_invoker`; con dueño postgres eso salta la RLS. Toda vista de public debe
-- ser security_invoker (lista de excepciones intencionales vacía: la landing lee
-- tablas con RLS, no vistas), y anon no lee ninguna vista de dinero/reconciliación.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'toda vista de public es security_invoker (excepciones intencionales: ninguna)',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v'
         AND c.relname <> ALL (ARRAY[]::text[])
         AND coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name='security_invoker'),'false') NOT IN ('true','on','1'))
       THEN '✅ PASS' ELSE '❌ FAIL — vista con permisos del dueño' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin SELECT en vistas de valor, libro y reconciliación',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v'
         AND c.relname IN ('valor_por_lote','movimientos_sin_vinculo','v_libro_economico','v_reconciliacion_membresia','v_pendientes_operativos')
         AND has_table_privilege('anon', c.oid, 'SELECT'))
       THEN '✅ PASS' ELSE '❌ FAIL — anon lee una vista financiera' END;

-- PKG-03A (20261009100000): PUBLIC no ejecuta funciones de aplicación (por ahí
-- las heredaba anon antes de 02C), y las RPC de servicio de entrega no son de
-- authenticated.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'PUBLIC sin EXECUTE en funciones de aplicación',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.objid=p.oid AND d.deptype='e'))
       THEN '✅ PASS' ELSE '❌ FAIL — PUBLIC ejecuta funciones' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'RPC de entrega (03A) solo para service_role',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('reclamar_correos_pendientes','notificacion_email_resultado','reclamar_push_pendientes',
                           'registrar_resultado_push','registrar_correo_directo')
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       THEN '✅ PASS' ELSE '❌ FAIL — authenticated ejecuta una RPC de entrega' END;

-- PKG-03B (20261011100000): la evidencia de entrega y de reconciliación no es de
-- anon, y el registro de corridas solo lo hace el reconciliador (service_role).
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin SELECT en evidencia operativa (correos directos, discrepancias, corridas)',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace
         AND c.relname IN ('correos_directos','discrepancias_stripe','reconciliacion_stripe_corridas')
         AND has_table_privilege('anon', c.oid, 'SELECT'))
       THEN '✅ PASS' ELSE '❌ FAIL — anon lee evidencia operativa' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'registrar_reconciliacion_stripe solo para service_role',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.proname = 'registrar_reconciliacion_stripe'
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')))
       THEN '✅ PASS' ELSE '❌ FAIL — el registro de reconciliación es invocable por clientes' END;

-- PKG-06A (20261013100000): las operaciones compuestas de cuenta son RPC de
-- servicio con actor por parámetro: si authenticated pudiera ejecutarlas, el
-- actor se forjaría. Y la guardia D-FIN-1 (historial durable) y la vinculación
-- elegible deben seguir en el cuerpo de las funciones.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'RPC de cuenta (06A) solo para service_role: el actor no se forja',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('cuenta_alta_preparar','cuenta_alta_finalizar','cuenta_cambiar_rol','cuenta_eliminar',
                           'cuenta_password_reseteada','staff_actualizar_cuenta','auth_usuario_sin_perfil',
                           'cuenta_historial_durable','_cuenta_huella_staff','_cuenta_actor','_cuenta_avisar_cambiar_password')
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')))
       AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
            AND p.proname IN ('cuenta_alta_preparar','cuenta_alta_finalizar','cuenta_cambiar_rol','cuenta_eliminar',
                              'cuenta_password_reseteada','staff_actualizar_cuenta','auth_usuario_sin_perfil')) = 7
       THEN '✅ PASS' ELSE '❌ FAIL — una RPC de cuenta falta o es invocable por clientes' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'contrato 06A: cuenta_eliminar consulta el historial durable y la huella; el alta en Auth no vincula perfiles con historial sin autorización',
  CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='cuenta_eliminar' AND pronamespace='public'::regnamespace) LIKE '%cuenta_historial_durable(%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='cuenta_eliminar' AND pronamespace='public'::regnamespace) LIKE '%_cuenta_huella_staff(%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='handle_new_auth_user' AND pronamespace='public'::regnamespace) LIKE '%EKKO_PERFIL_CON_HISTORIAL%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='handle_new_auth_user' AND pronamespace='public'::regnamespace) LIKE '%acceso_autorizado_at IS NULL%'
       THEN '✅ PASS' ELSE '❌ FAIL — se perdió la guardia de D-FIN-1 o la vinculación elegible' END;

-- PKG-06D (20261014110000): RLS decide filas; estos grants deciden columnas. El
-- cliente (authenticated/anon) no lee las columnas internas de usuarios ni las
-- del servidor en reservas; el staff las lee por RPC con guardia (06D-A).
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'usuarios: authenticated/anon sin SELECT en notas_admin, sancion_motivo, acceso_autorizado_*',
  CASE WHEN NOT EXISTS (SELECT 1 FROM unnest(ARRAY['notas_admin','sancion_motivo','acceso_autorizado_at','acceso_autorizado_por']) c
         WHERE has_column_privilege('authenticated', 'public.usuarios', c, 'SELECT')
            OR has_column_privilege('anon', 'public.usuarios', c, 'SELECT'))
         AND has_column_privilege('authenticated', 'public.usuarios', 'nombre', 'SELECT')
         AND has_column_privilege('authenticated', 'public.usuarios', 'notas_admin', 'UPDATE')
       THEN '✅ PASS' ELSE '❌ FAIL — columnas internas de usuarios legibles por el cliente (06D-B no aplicada)' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'reservas: authenticated/anon sin SELECT en observaciones ni qr_token_hash',
  CASE WHEN NOT has_column_privilege('authenticated', 'public.reservas', 'observaciones', 'SELECT')
         AND NOT has_column_privilege('anon', 'public.reservas', 'observaciones', 'SELECT')
         AND NOT has_column_privilege('authenticated', 'public.reservas', 'qr_token_hash', 'SELECT')
         AND has_column_privilege('authenticated', 'public.reservas', 'slot_inicio', 'SELECT')
       THEN '✅ PASS' ELSE '❌ FAIL — columnas del servidor en reservas legibles por el cliente (06D-B no aplicada)' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'contrato 06D: las RPC de lectura interna y la búsqueda exigen is_recepcionista() y el tenant del caller',
  CASE WHEN (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
              AND proname IN ('staff_datos_internos_cuenta','staff_observaciones_reserva','buscar_cuentas_staff')
              AND prosrc LIKE '%is_recepcionista()%' AND prosrc LIKE '%get_my_tenant_id()%' AND prosecdef) = 3
         AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
              AND proname IN ('staff_datos_internos_cuenta','staff_observaciones_reserva','buscar_cuentas_staff')
              AND has_function_privilege('anon', oid, 'EXECUTE'))
       THEN '✅ PASS' ELSE '❌ FAIL — RPC de 06D sin guardia o ejecutable por anon' END;

-- PKG-06G (20261015100000): la salud de los procesos solo la escribe el servidor,
-- y el resumen de push fallidos no abre la política de avisos ni sirve a anon.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'procesos_programados: sin escritura de clientes; registrar_ejecucion_proceso solo service_role',
  CASE WHEN NOT has_table_privilege('authenticated', 'public.procesos_programados', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.procesos_programados', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.procesos_programados', 'DELETE')
         AND NOT has_table_privilege('anon', 'public.procesos_programados', 'SELECT')
         AND NOT has_function_privilege('authenticated', 'public.registrar_ejecucion_proceso(text, text, text)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.registrar_ejecucion_proceso(text, text, text)', 'EXECUTE')
         AND has_function_privilege('service_role', 'public.registrar_ejecucion_proceso(text, text, text)', 'EXECUTE')
       THEN '✅ PASS' ELSE '❌ FAIL — el estado de los procesos es escribible por clientes' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'contrato 06G: resumen_fallos_push agrega (sin contenido) con guardia admin+tenant; revisar_fallos_push exige admin y nota',
  CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='resumen_fallos_push' AND pronamespace='public'::regnamespace) LIKE '%is_admin()%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='resumen_fallos_push' AND pronamespace='public'::regnamespace) LIKE '%get_my_tenant_id()%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='resumen_fallos_push' AND pronamespace='public'::regnamespace) NOT LIKE '%mensaje%'
         AND NOT has_function_privilege('anon', 'public.resumen_fallos_push()', 'EXECUTE')
         AND (SELECT prosrc FROM pg_proc WHERE proname='revisar_fallos_push' AND pronamespace='public'::regnamespace) LIKE '%EKKO_NOTA_REQUERIDA%'
       THEN '✅ PASS' ELSE '❌ FAIL — guardia o contrato de 06G perdido' END;

-- PKG-06B (20261016100000): las operaciones de cobro del miembro y del webhook.
-- Lo que asienta resultados es del servidor; el miembro solo deja SU intención; el
-- ejecutor genérico jamás entrega un cambio de plan.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'RPC de 06B: registro/cierre de cambio de plan y sub anterior solo service_role; miembro_programar_renovacion sin anon',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND p.proname IN ('cambio_plan_registrar','cambio_plan_resultado','registrar_cancelacion_suscripcion_anterior')
         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')))
       AND NOT has_function_privilege('anon', 'public.miembro_programar_renovacion(boolean, uuid)', 'EXECUTE')
       AND (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
            AND proname IN ('cambio_plan_registrar','cambio_plan_resultado','registrar_cancelacion_suscripcion_anterior','miembro_programar_renovacion')) = 4
       THEN '✅ PASS' ELSE '❌ FAIL — una RPC de 06B falta o es invocable por quien no debe' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'contrato 06B: preparar no entrega cambiar_plan; la sub anterior espera a la membresía vieja; reactivar respeta revocación, sanción y baja del estudio',
  CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='operacion_suscripcion_preparar' AND pronamespace='public'::regnamespace) LIKE '%lo_ejecuta_el_miembro%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='operacion_suscripcion_preparar' AND pronamespace='public'::regnamespace) LIKE '%membresia_anterior_vigente%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='miembro_programar_renovacion' AND pronamespace='public'::regnamespace) LIKE '%EKKO_CUENTA_REVOCADA%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='miembro_programar_renovacion' AND pronamespace='public'::regnamespace) LIKE '%EKKO_BAJA_DEL_ESTUDIO%'
         AND (SELECT prosrc FROM pg_proc WHERE proname='staff_reintentar_operacion_cobro' AND pronamespace='public'::regnamespace) LIKE '%EKKO_OPERACION_NO_REINTENTABLE%'
       THEN '✅ PASS' ELSE '❌ FAIL — se perdió una guardia de 06B' END;

-- ── Resultado ────────────────────────────────────────────────────────────────
SELECT area, caso, resultado FROM _hardening_resultado ORDER BY id;
