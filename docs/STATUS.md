# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-05 · PKG-02C commiteado en local (sin push).

## Producción (verificado 2026-10-05)
- Commit publicado: `a80a8df` (main = origin/main): "chore(ai): finalize context
  routing and stabilize gate" (arquitectura de contexto fase 4), DEPLOYED y validado.
- Netlify deploy `6ac40b26b5977f0009462dd3`, publicado 2026-10-05 20:41 UTC.
- Antes: `46ecd0a` (fix de material, otra sesión; verificación en vivo del
  comportamiento pendiente, no bloqueante), `24e0a8d` (contexto fases 1–3) y
  `f3ee401` (R2-B, último cambio de negocio verificado en producción).
- Supabase: 102/102 migraciones; última `20261005110000_r2b_terminacion_cancelacion_y_cobro.sql`.
- Datos de negocio: 0 membresías vivas, 0 suscripciones de Stripe vivas, 0 reservas
  futuras, 0 sancionados/revocados. Stripe en modo live (cuenta de plataforma
  compartida con otros proyectos; EKKO filtra por cuenta conectada y `metadata.app`).

## Cerrado en producción (no se reabre sin regresión concreta)
R1 · PKG-00A, 00C, 00E, 00F, 00G · PKG-01A–01H · R2-A (01I–01M) · R2-B (01N–01Q) ·
PKG-02A, 02B · Arquitectura de contexto fases 1–4 (PUBLICADA / VALIDADA / CERRADA).
Qué decidió cada uno: `docs/DECISIONS_INDEX.md` → `DECISIONS.md`.
Evidencia: migraciones `supabase/migrations/`, pruebas `src/__tests__/db/`.

## Solo en local
- PKG-02C "Frontera de autorización por REST: avisos, notas y grants" —
  COMMITTED en local (un commit, ver `git log`), gate verde (193 archivos / 1801
  pruebas), SIN PUSH / SIN DEPLOY / MIGRACIÓN NO APLICADA.
  Migración `20261006100000_02c_frontera_rest_avisos_y_grants.sql` (no aplicada en
  producción). Decisión EKKO-136. Pruebas: `src/__tests__/db/02c-frontera-rest.db.test.ts`,
  `hardening_checks.sql` §P5. Tres aserciones de 01L (`r2a-reservas.db.test.ts`)
  pasan de "0 filas por RLS" a "permission denied" por GRANT: mismo resultado.

## Escritor único
Un solo agente o sesión escribe en este árbol a la vez; las demás son de solo lectura.
Antes de commit/push/deploy se re-verifica HEAD, origin/main, árbol y lo stageado; una
deriva sin explicar detiene todo (ya pasó una vez el 2026-10-05).

## Estado local que se preserva
- Stash `pre-pkg-00f-local-ui-tests` (3 archivos: enlace "Volver a EKKO" en Login y
  dos pruebas). No se aplica, no se borra, no se commitea.

## Diferido / pendiente no bloqueante
- Validación con el PRIMER evento real (sin fabricar nada): pago live, staff, sanción,
  revocación, cancelación tardía, revisiones financieras. Checklist:
  `VALIDACION_PRIMER_USO.md`.
- Credencial de la cuenta demo: riesgo aceptado por el dueño. NO remediar.

## Residuales conocidos (para paquetes posteriores; no corregir de paso)
- (Resueltos en local por PKG-02C, pendientes de activación: INSERT/UPDATE de
  notificaciones, rol del autor de notas, EXECUTE de anon/PUBLIC, grants por defecto.)
- Finanzas: no se guardan comisiones de Stripe; ventas de mostrador sin evidencia de
  anulación; `stripe_price_id` sin uso; default de 2 invitados en
  `reservas_incompatibles_con_tier`.
- Si staff reanuda a mano una membresía pausada por sanción, el cobro vuelve.
- Carrera intermitente en `usePlanesActivos.test.tsx` (PKG-02A; 1 fallo en 17 gates),
  sin tocar. `sentry-lib.test.ts` (5 s) puede expirar bajo carga; aislado pasa.
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
Revisión del dueño del commit de PKG-02C → push (autorización aparte) → activación
con `ekko-activar` (otra autorización). Ningún paquete posterior está autorizado; un
backlog o una auditoría antigua no es autorización.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
