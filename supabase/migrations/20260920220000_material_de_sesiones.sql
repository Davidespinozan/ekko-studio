-- ============================================================================
-- Entrega y descarga del material de cada sesión (solicitud del cliente, punto 5)
-- ============================================================================
-- Flujo: grabación → procesamiento → CARGA en la plataforma → aviso al miembro →
-- descarga. Cada miembro tiene su espacio ("Mi material") con lo generado en sus
-- sesiones, identificado por fecha y set.
--
-- Un material es un ARCHIVO subido al bucket privado `material`, o un ENLACE
-- externo (Drive, Dropbox, Frame.io…). Lo segundo no es un parche: una hora de
-- video pesa varios GB y subirla al almacenamiento de la app es lento y caro; el
-- estudio elige por archivo. Para el miembro se ven igual.
--
-- Seguridad:
--  · El miembro solo ve y descarga lo SUYO, y solo mientras esté vigente
--    (`disponible_hasta`) — la vigencia se hace cumplir también en Storage: sin una
--    fila vigente, ni con la ruta exacta se puede firmar una URL.
--  · El staff (admin/recepción ACTIVOS) gestiona lo de su estudio, siempre por RPC
--    (valida la reserva, deriva al dueño, audita). No hay INSERT directo.
--  · Ruta del archivo: <tenant>/<usuario>/<reserva>/<uuid>-<nombre>.
--
-- Tests conductuales: src/__tests__/db/material.db.test.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS material_sesion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reserva_id        uuid NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
  usuario_id        uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo              text NOT NULL CHECK (tipo IN ('archivo', 'enlace')),
  titulo            text NOT NULL CHECK (length(trim(titulo)) BETWEEN 1 AND 160),
  storage_path      text,
  url_externa       text,
  nombre_archivo    text,
  tamano_bytes      bigint CHECK (tamano_bytes IS NULL OR tamano_bytes >= 0),
  mime              text,
  disponible_hasta  timestamptz,           -- NULL = sin vencimiento
  subido_por        uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  eliminado_at      timestamptz,
  CONSTRAINT material_archivo_o_enlace CHECK (
    (tipo = 'archivo' AND storage_path IS NOT NULL AND url_externa IS NULL)
    OR (tipo = 'enlace' AND url_externa ~* '^https://[^\s]+$' AND storage_path IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS material_usuario_idx ON material_sesion (usuario_id, created_at DESC) WHERE eliminado_at IS NULL;
CREATE INDEX IF NOT EXISTS material_reserva_idx ON material_sesion (reserva_id) WHERE eliminado_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS material_storage_path_uniq ON material_sesion (storage_path) WHERE storage_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_por_expirar_idx ON material_sesion (disponible_hasta)
  WHERE eliminado_at IS NULL AND tipo = 'archivo' AND disponible_hasta IS NOT NULL;

ALTER TABLE material_sesion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS material_read_self ON material_sesion;
CREATE POLICY material_read_self ON material_sesion
  FOR SELECT TO authenticated
  USING (
    usuario_id = get_my_user_id()
    AND eliminado_at IS NULL
    AND (disponible_hasta IS NULL OR disponible_hasta > now())
  );

DROP POLICY IF EXISTS material_read_staff ON material_sesion;
CREATE POLICY material_read_staff ON material_sesion
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- Escrituras SOLO por las RPC de abajo (SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE ON material_sesion FROM authenticated, anon;

-- ── Bucket privado ──────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('material', 'material', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS material_staff_all ON storage.objects;
CREATE POLICY material_staff_all ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'material'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
    AND is_recepcionista()
  )
  WITH CHECK (
    bucket_id = 'material'
    AND (storage.foldername(name))[1] = get_my_tenant_id()::text
    AND is_recepcionista()
  );

-- El miembro firma la URL de descarga con SU token: solo si hay una fila vigente
-- que apunte a ese objeto y sea suya.
DROP POLICY IF EXISTS material_miembro_descarga ON storage.objects;
CREATE POLICY material_miembro_descarga ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'material'
    AND EXISTS (
      SELECT 1 FROM material_sesion ms
      WHERE ms.storage_path = storage.objects.name
        AND ms.usuario_id = get_my_user_id()
        AND ms.eliminado_at IS NULL
        AND (ms.disponible_hasta IS NULL OR ms.disponible_hasta > now())
    )
  );

-- ── RPC: registrar un material ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION staff_registrar_material(
  p_reserva_id uuid,
  p_tipo text,
  p_titulo text,
  p_storage_path text DEFAULT NULL,
  p_url_externa text DEFAULT NULL,
  p_nombre_archivo text DEFAULT NULL,
  p_tamano_bytes bigint DEFAULT NULL,
  p_mime text DEFAULT NULL,
  p_dias_disponible integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_dias integer;
  v_hasta timestamptz;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede subir material';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id AND tenant_id = v_tenant;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada en este estudio';
  END IF;
  IF v_reserva.status IN ('cancelada', 'cancelada_admin') THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_VALIDA: No se entrega material de una sesión cancelada';
  END IF;

  IF p_tipo = 'archivo' THEN
    -- La ruta la arma el front, pero tiene que ser la de ESTA reserva: si no, un
    -- staff podría "entregar" a un miembro el archivo de otro.
    IF p_storage_path IS NULL OR p_storage_path NOT LIKE
       v_tenant::text || '/' || v_reserva.usuario_id::text || '/' || v_reserva.id::text || '/%' THEN
      RAISE EXCEPTION 'EKKO_RUTA_INVALIDA: El archivo no está en la carpeta de esta reserva';
    END IF;
  ELSIF p_tipo = 'enlace' THEN
    IF p_url_externa IS NULL OR p_url_externa !~* '^https://[^\s]+$' THEN
      RAISE EXCEPTION 'EKKO_ENLACE_INVALIDO: El enlace debe empezar con https://';
    END IF;
  ELSE
    RAISE EXCEPTION 'EKKO_TIPO_INVALIDO: tipo debe ser archivo o enlace';
  END IF;

  -- Vigencia: la que pida el staff; si no, la del estudio (config.material.dias_disponible,
  -- 30 por defecto). 0 = sin vencimiento.
  v_dias := COALESCE(
    p_dias_disponible,
    (SELECT (config->'material'->>'dias_disponible')::integer FROM tenants WHERE id = v_tenant),
    30
  );
  IF v_dias < 0 OR v_dias > 3650 THEN
    RAISE EXCEPTION 'EKKO_VIGENCIA_INVALIDA: La vigencia debe estar entre 0 y 3650 días';
  END IF;
  v_hasta := CASE WHEN v_dias = 0 THEN NULL ELSE now() + make_interval(days => v_dias) END;

  INSERT INTO material_sesion (
    tenant_id, reserva_id, usuario_id, tipo, titulo, storage_path, url_externa,
    nombre_archivo, tamano_bytes, mime, disponible_hasta, subido_por
  ) VALUES (
    v_tenant, v_reserva.id, v_reserva.usuario_id, p_tipo, trim(p_titulo),
    CASE WHEN p_tipo = 'archivo' THEN p_storage_path END,
    CASE WHEN p_tipo = 'enlace' THEN trim(p_url_externa) END,
    p_nombre_archivo, p_tamano_bytes, p_mime, v_hasta, v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, despues, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'material_subido', 'usuario', v_reserva.usuario_id,
          jsonb_build_object('titulo', trim(p_titulo), 'tipo', p_tipo),
          jsonb_build_object('material_id', v_id, 'reserva_id', v_reserva.id, 'folio', v_reserva.folio));

  RETURN jsonb_build_object('success', true, 'material_id', v_id, 'disponible_hasta', v_hasta);
END;
$$;

-- ── RPC: avisar al miembro (UNA vez por tanda, no por archivo) ───────────────
CREATE OR REPLACE FUNCTION staff_avisar_material(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
  v_n integer;
  v_set text;
  v_hasta timestamptz;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede avisar';
  END IF;
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id AND tenant_id = v_tenant;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada en este estudio';
  END IF;

  SELECT count(*), min(disponible_hasta) INTO v_n, v_hasta
  FROM material_sesion
  WHERE reserva_id = p_reserva_id AND eliminado_at IS NULL
    AND (disponible_hasta IS NULL OR disponible_hasta > now());
  IF v_n = 0 THEN
    RAISE EXCEPTION 'EKKO_SIN_MATERIAL: Esta sesión todavía no tiene material disponible';
  END IF;

  -- Un doble clic (o dos personas del equipo) no manda dos correos.
  IF EXISTS (
    SELECT 1 FROM notificaciones
    WHERE usuario_id = v_reserva.usuario_id AND tipo = 'material_disponible'
      AND metadata->>'reserva_id' = p_reserva_id::text
      AND creada_at > now() - interval '10 minutes'
  ) THEN
    RETURN jsonb_build_object('success', true, 'ya_avisado', true);
  END IF;

  SELECT nombre INTO v_set FROM recursos WHERE id = v_reserva.recurso_id;

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_tenant, v_reserva.usuario_id, 'material_disponible',
    'Tu material está listo',
    'Ya puedes descargar el material de tu sesión en ' || COALESCE(v_set, 'el estudio')
      || ' del ' || _fecha_hora_estudio(v_reserva.slot_inicio)
      || ' (' || v_n || CASE WHEN v_n = 1 THEN ' archivo' ELSE ' archivos' END || ').'
      || CASE WHEN v_hasta IS NOT NULL
              THEN ' Disponible hasta el ' || split_part(_fecha_hora_estudio(v_hasta), ',', 1) || '.'
              ELSE '' END,
    jsonb_build_object('reserva_id', p_reserva_id, 'url', '/app/material', 'archivos', v_n)
  );

  RETURN jsonb_build_object('success', true, 'archivos', v_n);
END;
$$;

-- ── RPC: retirar un material ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION staff_eliminar_material(p_material_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_mat material_sesion;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede retirar material';
  END IF;
  SELECT * INTO v_mat FROM material_sesion WHERE id = p_material_id AND tenant_id = v_tenant AND eliminado_at IS NULL;
  IF v_mat.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MATERIAL_NO_EXISTE: Material no encontrado';
  END IF;

  UPDATE material_sesion SET eliminado_at = now() WHERE id = v_mat.id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'material_retirado', 'usuario', v_mat.usuario_id,
          jsonb_build_object('titulo', v_mat.titulo, 'tipo', v_mat.tipo),
          jsonb_build_object('material_id', v_mat.id, 'reserva_id', v_mat.reserva_id));

  -- El front borra el objeto de Storage con esta ruta (el staff tiene policy).
  RETURN jsonb_build_object('success', true, 'storage_path', v_mat.storage_path);
END;
$$;

REVOKE ALL ON FUNCTION staff_registrar_material(uuid, text, text, text, text, text, bigint, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION staff_avisar_material(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION staff_eliminar_material(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_registrar_material(uuid, text, text, text, text, text, bigint, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION staff_avisar_material(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION staff_eliminar_material(uuid) TO authenticated;

-- ── Limpieza: archivos vencidos ─────────────────────────────────────────────
-- Devuelve (y marca) los archivos cuya vigencia terminó, para que el cron borre
-- los objetos de Storage. Solo service_role.
CREATE OR REPLACE FUNCTION material_vencido_por_borrar(p_limite integer DEFAULT 100)
RETURNS TABLE (material_id uuid, storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE material_sesion ms
  SET eliminado_at = now()
  WHERE ms.id IN (
    SELECT m.id FROM material_sesion m
    WHERE m.eliminado_at IS NULL AND m.tipo = 'archivo'
      AND m.disponible_hasta IS NOT NULL
      -- 7 días de colchón tras vencer: por si el estudio decide extender la vigencia.
      AND m.disponible_hasta < now() - interval '7 days'
    ORDER BY m.disponible_hasta
    LIMIT GREATEST(1, LEAST(p_limite, 500))
  )
  RETURNING ms.id, ms.storage_path;
END;
$$;
REVOKE ALL ON FUNCTION material_vencido_por_borrar(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION material_vencido_por_borrar(integer) TO service_role;
