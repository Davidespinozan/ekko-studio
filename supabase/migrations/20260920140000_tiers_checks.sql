-- ============================================================================
-- CHECKs de `tiers`: un paquete no puede nacer vencido ni vacío
-- ============================================================================
-- Bug (SALA_PARITY_AUDIT_2 · D1): el form de planes hacía `parseInt(x) || 0` y
-- dejaba guardar un paquete híbrido con `duracion_dias = 0`. Ese paquete nace
-- vencido: el miembro paga y el siguiente cron le pone los créditos en cero.
-- Lo mismo con `clases_incluidas` 0/NULL en un paquete (alta cobrada con saldo 0).
-- SALA: 20260613002800:22-27, 20260717120000:22-27.
--
-- Se agregan NOT VALID (rigen para toda fila nueva o editada) y se intenta
-- validar lo existente; si hay una fila vieja que no cumple, la migración NO
-- truena: avisa cuál es para corregirla a mano.
-- ============================================================================

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_precio_no_negativo;
ALTER TABLE tiers ADD CONSTRAINT tiers_precio_no_negativo
  CHECK (precio_centavos >= 0) NOT VALID;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_duracion_positiva;
ALTER TABLE tiers ADD CONSTRAINT tiers_duracion_positiva
  CHECK (duracion_dias IS NULL OR duracion_dias >= 1) NOT VALID;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_paquete_con_sesiones;
ALTER TABLE tiers ADD CONSTRAINT tiers_paquete_con_sesiones
  CHECK (tipo NOT IN ('creditos', 'hibrido') OR COALESCE(clases_incluidas, 0) >= 1) NOT VALID;

ALTER TABLE tiers DROP CONSTRAINT IF EXISTS tiers_hibrido_con_vigencia;
ALTER TABLE tiers ADD CONSTRAINT tiers_hibrido_con_vigencia
  CHECK (tipo <> 'hibrido' OR duracion_dias IS NOT NULL) NOT VALID;

ALTER TABLE membresias DROP CONSTRAINT IF EXISTS membresias_creditos_no_negativos;
ALTER TABLE membresias ADD CONSTRAINT membresias_creditos_no_negativos
  CHECK (creditos_restantes IS NULL OR creditos_restantes >= 0) NOT VALID;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('tiers', 'tiers_precio_no_negativo'),
      ('tiers', 'tiers_duracion_positiva'),
      ('tiers', 'tiers_paquete_con_sesiones'),
      ('tiers', 'tiers_hibrido_con_vigencia'),
      ('membresias', 'membresias_creditos_no_negativos')
    ) AS t(tabla, nombre)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.tabla, c.nombre);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'Hay filas viejas en % que no cumplen %: corrígelas y corre ALTER TABLE % VALIDATE CONSTRAINT %;',
        c.tabla, c.nombre, c.tabla, c.nombre;
    END;
  END LOOP;
END $$;
