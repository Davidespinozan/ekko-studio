-- ============================================================================
-- Storage: la ESCRITURA queda atada al tenant (estudios, logos, avatars)
-- ============================================================================
-- Las 9 policies de escritura solo exigían "rol admin" (las de avatars además
-- aceptaban un rol 'staff' que no existe y no decían TO authenticated), sin atar
-- el objeto al tenant → un admin del tenant A podía sobrescribir o borrar las
-- fotos, logos y avatares del tenant B. M3 de SECURITY_AUDIT.md, abierto desde
-- mayo. La LECTURA sigue pública a propósito (fotos/logos/avatars públicos).
--
-- Las rutas ya siguen una convención por tenant, así que el front no cambia:
--   estudios → `<slug-del-tenant>/<slug-estudio>-<ts>.<ext>`  (Recursos.tsx)
--   logos    → `<slug-del-tenant>/<logo-dark|og-image|favicon>-<ts>.<ext>` (AjustesMarca.tsx)
--   avatars  → `<usuario_id>/<ts>.<ext>`  (MiembroDetalle.tsx; recepción sube por
--              service_role en reception-update-member, que no pasa por RLS)
-- Se valida contra get_my_tenant_id(), nunca contra un dato del cliente.
-- Portado de SALA (20260613000500 + 20260804200000). Idempotente.
-- ============================================================================

-- ── ESTUDIOS: 1er segmento = slug de MI tenant ───────────────────────────────
DROP POLICY IF EXISTS "Estudios admin upload" ON storage.objects;
CREATE POLICY "Estudios admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'estudios'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Estudios admin update" ON storage.objects;
CREATE POLICY "Estudios admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Estudios admin delete" ON storage.objects;
CREATE POLICY "Estudios admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'estudios'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

-- ── LOGOS: mismo criterio ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Logos admin upload" ON storage.objects;
CREATE POLICY "Logos admin upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Logos admin update" ON storage.objects;
CREATE POLICY "Logos admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "Logos admin delete" ON storage.objects;
CREATE POLICY "Logos admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'logos'
    AND is_admin()
    AND (storage.foldername(name))[1] = (SELECT slug FROM tenants WHERE id = get_my_tenant_id())
  );

-- ── AVATARS: 1er segmento = id de un usuario de MI tenant ────────────────────
DROP POLICY IF EXISTS "avatars_admin_write" ON storage.objects;
CREATE POLICY "avatars_admin_write"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "avatars_admin_update" ON storage.objects;
CREATE POLICY "avatars_admin_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS "avatars_admin_delete" ON storage.objects;
CREATE POLICY "avatars_admin_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND is_admin()
    AND (storage.foldername(name))[1] IN (SELECT id::text FROM usuarios WHERE tenant_id = get_my_tenant_id())
  );

-- ── Self-test: las 9 policies atan al path y al tenant ───────────────────────
DO $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT policyname, coalesce(qual, with_check) AS expr
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN (
        'Estudios admin upload','Estudios admin update','Estudios admin delete',
        'Logos admin upload','Logos admin update','Logos admin delete',
        'avatars_admin_write','avatars_admin_update','avatars_admin_delete'
      )
  LOOP
    v_n := v_n + 1;
    IF position('foldername' in r.expr) = 0 OR position('get_my_tenant_id' in r.expr) = 0 THEN
      RAISE EXCEPTION 'storage policy % no ata el objeto al tenant', r.policyname;
    END IF;
  END LOOP;
  IF v_n <> 9 THEN
    RAISE EXCEPTION 'se esperaban 9 policies de escritura con scope de tenant, hay %', v_n;
  END IF;
END $$;
