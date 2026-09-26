-- ============================================================================
-- PRECHECK READ-ONLY · Fase 1 de identidad única (2026-09-25)
-- Pegar en el SQL editor de Supabase (producción) ANTES de aplicar las
-- migraciones 20260925*. Solo SELECT: no modifica nada.
-- Bloques A–K + detalle de duplicados + preview del backfill de sanción.
-- ============================================================================

-- A–D. Volumen y correos
SELECT 'A_usuarios_total' AS metrica, count(*) AS valor FROM usuarios
UNION ALL SELECT 'A_miembros', count(*) FROM usuarios WHERE rol = 'miembro'
UNION ALL SELECT 'B_con_auth_id', count(*) FROM usuarios WHERE auth_id IS NOT NULL
UNION ALL SELECT 'C_sin_auth_id', count(*) FROM usuarios WHERE auth_id IS NULL
UNION ALL SELECT 'D_email_null_o_vacio', count(*) FROM usuarios WHERE email IS NULL OR trim(email) = ''
UNION ALL SELECT 'D2_email_con_espacios_o_mayusculas', count(*) FROM usuarios WHERE email <> lower(trim(email))
UNION ALL SELECT 'auth_users_total', count(*) FROM auth.users
UNION ALL SELECT 'auth_sin_perfil', count(*) FROM auth.users a WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_id = a.id)
UNION ALL SELECT 'auth_email_distinto_de_usuarios_email', count(*) FROM auth.users a JOIN usuarios u ON u.auth_id = a.id
  WHERE lower(trim(a.email)) <> lower(trim(u.email));

-- C (detalle). Filas sin auth_id: son las que el trigger nuevo vincularía si esa persona se da de alta
SELECT 'C_detalle_sin_auth_id' AS metrica, id, tenant_id, email, rol, status, created_at
FROM usuarios WHERE auth_id IS NULL ORDER BY created_at;

-- E. Duplicados EXACTOS (deberían ser 0: UNIQUE(tenant_id,email))
SELECT 'E_email_duplicado_exacto' AS metrica, tenant_id, email, count(*) AS cantidad
FROM usuarios GROUP BY tenant_id, email HAVING count(*) > 1;

-- F. Duplicados por lower(trim(email)) — BLOQUEAN el índice único 20260925110000
SELECT 'F_email_duplicado_normalizado' AS metrica,
       tenant_id,
       lower(trim(email)) AS email_normalizado,
       count(*) AS cantidad,
       array_agg(id ORDER BY created_at) AS ids,
       array_agg(COALESCE(auth_id::text, 'NULL') ORDER BY created_at) AS auth_ids,
       array_agg(status ORDER BY created_at) AS statuses,
       array_agg(rol ORDER BY created_at) AS roles
FROM usuarios
GROUP BY tenant_id, lower(trim(email))
HAVING count(*) > 1;

-- G. auth_id duplicados (imposible por UNIQUE(auth_id); se comprueba igual)
SELECT 'G_auth_id_duplicado' AS metrica, auth_id, count(*) AS cantidad, array_agg(id) AS ids
FROM usuarios WHERE auth_id IS NOT NULL GROUP BY auth_id HAVING count(*) > 1;

-- H–J. Suspendidos
SELECT 'H_miembros_suspendidos' AS metrica, count(*) AS valor FROM usuarios WHERE rol = 'miembro' AND status = 'suspendido'
UNION ALL SELECT 'I_suspendidos_con_membresia_pausada', count(*) FROM usuarios u
  WHERE u.rol = 'miembro' AND u.status = 'suspendido'
    AND EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status = 'pausada')
UNION ALL SELECT 'J_suspendidos_sin_membresia_pausada_(recibirian_sancion)', count(*) FROM usuarios u
  WHERE u.rol = 'miembro' AND u.status = 'suspendido'
    AND NOT EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status = 'pausada')
UNION ALL SELECT 'staff_revocado', count(*) FROM usuarios WHERE rol IN ('admin','recepcionista','staff') AND status = 'revocado'
UNION ALL SELECT 'staff_suspendido_(no_recibe_sancion)', count(*) FROM usuarios WHERE rol IN ('admin','recepcionista','staff') AND status = 'suspendido';

-- K. PREVIEW EXACTO DEL BACKFILL (la migración 20260925100000 marca sanción a estas filas)
--    Regla: rol='miembro' AND status='suspendido' AND sin membresía 'pausada'.
SELECT 'K_backfill_sancion' AS metrica,
       u.id AS usuario_id,
       u.email,
       u.status AS status_actual,
       (SELECT m.id FROM membresias m WHERE m.usuario_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS membresia_actual,
       (SELECT m.status FROM membresias m WHERE m.usuario_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS estado_membresia,
       EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status = 'pausada') AS pausa,
       u.updated_at AS ultimo_cambio,
       NULL::timestamptz AS sancionado_at_actual,      -- la columna aún no existe
       NULL::text AS motivo_actual,
       'sancionado_at = updated_at; sancion_motivo = migración; status queda suspendido' AS resultado_esperado
FROM usuarios u
WHERE u.rol = 'miembro' AND u.status = 'suspendido'
  AND NOT EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status = 'pausada')
ORDER BY u.updated_at;

-- K2. Último motivo auditado de la suspensión (para revisar si fue sanción real)
SELECT 'K2_ultimo_status_change' AS metrica, a.target_id AS usuario_id, a.creada_at, a.actor_rol, a.motivo, a.despues
FROM audit_log a
WHERE a.accion = 'status_change' AND a.despues->>'status' = 'suspendido'
  AND a.target_id IN (SELECT id FROM usuarios WHERE rol = 'miembro' AND status = 'suspendido')
ORDER BY a.target_id, a.creada_at DESC;

-- L. Estados comerciales imposibles (entrada de Fase 2, informativo)
SELECT 'L_activo_sin_membresia_viva' AS metrica, count(*) AS valor FROM usuarios u
 WHERE u.rol = 'miembro' AND u.status = 'activo'
   AND NOT EXISTS (SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status IN ('trialing','activa','past_due'))
UNION ALL SELECT 'L_tier_sin_membresia_compatible', count(*) FROM usuarios u
 WHERE u.membresia_tier IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM membresias m JOIN tiers t ON t.id = m.tier_id
                   WHERE m.usuario_id = u.id AND t.slug = u.membresia_tier
                     AND m.status IN ('trialing','activa','past_due','pausada','pendiente'))
UNION ALL SELECT 'L_activa_id_no_viva', count(*) FROM usuarios u JOIN membresias m ON m.id = u.membresia_activa_id
 WHERE m.status NOT IN ('trialing','activa','past_due','pausada');

-- M. Stripe: discrepancias de customer (entrada de Fase 2)
SELECT 'M_customer_distinto_dp_vs_membresias' AS metrica, count(*) AS valor
FROM usuarios_datos_privados d JOIN membresias m ON m.usuario_id = d.usuario_id
WHERE m.stripe_customer_id IS NOT NULL AND d.stripe_customer_id IS NOT NULL AND m.stripe_customer_id <> d.stripe_customer_id
UNION ALL SELECT 'M_customer_solo_en_membresias', count(DISTINCT m.usuario_id)
FROM membresias m LEFT JOIN usuarios_datos_privados d ON d.usuario_id = m.usuario_id
WHERE m.stripe_customer_id IS NOT NULL AND d.stripe_customer_id IS NULL
UNION ALL SELECT 'M_customer_repetido_en_dp', count(*) FROM (
  SELECT stripe_customer_id FROM usuarios_datos_privados WHERE stripe_customer_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;

-- N. Huérfanos (informativo)
SELECT 'N_payment_events_sin_usuario' AS metrica, count(*) AS valor FROM payment_events WHERE usuario_id IS NULL
UNION ALL SELECT 'N_audit_target_usuario_inexistente', count(*) FROM audit_log a
 WHERE a.target_tipo = 'usuario' AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = a.target_id);

-- O. "Allow new users to sign up": NO es consultable por SQL.
--    MANUAL PRODUCTION CHECK REQUIRED: Dashboard → Authentication → Providers → Email.
