# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-05 · tras el fix de material (46ecd0a).

## Producción (verificado 2026-10-05)
- Commit publicado: `46ecd0af9dfd95dc4222f0098b7fb3ac556c8533` (main = origin/main):
  "fix(material): clean storage object on record failure", DEPLOYED (otra sesión
  autorizada; verificación en vivo del comportamiento: pendiente, no bloqueante).
- Netlify deploy `6ac3fc765e255000087b3cff`, publicado 2026-10-05 19:39 UTC.
- Antes: `24e0a8d` (contexto fases 1–3) y `f3ee401` (R2-B, último cambio de negocio
  verificado en producción).
- Supabase: 102/102 migraciones; última `20261005110000_r2b_terminacion_cancelacion_y_cobro.sql`.
- Datos de negocio: 0 membresías vivas, 0 suscripciones de Stripe vivas, 0 reservas
  futuras, 0 sancionados/revocados. Stripe en modo live (cuenta de plataforma
  compartida con otros proyectos; EKKO filtra por cuenta conectada y `metadata.app`).

## Cerrado en producción (no se reabre sin regresión concreta)
R1 · PKG-00A, 00C, 00E, 00F, 00G · PKG-01A–01H · R2-A (01I–01M) · R2-B (01N–01Q) ·
PKG-02A, 02B · Arquitectura de contexto fases 1–3 (PUBLICADA / VALIDADA / CERRADA).
Qué decidió cada uno: `docs/DECISIONS_INDEX.md` → `DECISIONS.md`.
Evidencia: migraciones `supabase/migrations/`, pruebas `src/__tests__/db/`.

## Solo en local
- Nada de negocio. Arquitectura de contexto fase 4 (`docs/ARCHITECTURE.md`, notas en
  `docs/arquitectura/`, archivo de históricos en `docs/archive/`, ruteo de skills): en
  curso en el árbol de trabajo; su publicación se lee en git y Netlify, no aquí.

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
- Notificaciones: la política de INSERT no exige estado activo; el UPDATE no tiene
  WITH CHECK. El rol del autor de notas lo manda el cliente.
- EXECUTE de `anon` en las dos RPC de reserva (grant por defecto; sin sesión fallan).
- Privilegios de tabla por defecto de Supabase sobre tablas de evidencia: los
  frena RLS, no el GRANT.
- Finanzas: no se guardan comisiones de Stripe; ventas de mostrador sin evidencia de
  anulación; `stripe_price_id` sin uso; default de 2 invitados en
  `reservas_incompatibles_con_tier`.
- Si staff reanuda a mano una membresía pausada por sanción, el cobro vuelve.
- Hook `beforeAll` de `stripe-eventos.db.test.ts` con límite por defecto (10 s); carrera
  intermitente en `usePlanesActivos.test.tsx` (PKG-02A; 1 fallo en 17 gates), sin tocar.
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
Revisión del dueño de la fase 4 de la arquitectura de contexto. Ningún paquete de
remediación (02C+) está autorizado; un backlog o una auditoría antigua no es autorización.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
