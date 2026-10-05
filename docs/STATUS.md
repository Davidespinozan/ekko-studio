# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-05 · tras cerrar R2-B.

## Producción (verificado 2026-10-05)
- Commit publicado: `f3ee401ca5b7e4d10064297439132056ab7f7fef` (main = origin/main).
- Netlify deploy `6ac3d0ac59e1180008cb9eb8`, publicado 2026-10-05 16:32:18 UTC.
- Supabase: 102/102 migraciones; última `20261005110000_r2b_terminacion_cancelacion_y_cobro.sql`.
- Datos de negocio: 0 membresías vivas, 0 suscripciones de Stripe vivas, 0 reservas
  futuras, 0 sancionados/revocados. Stripe en modo live (cuenta de plataforma
  compartida con otros proyectos; EKKO filtra por cuenta conectada y `metadata.app`).

## Cerrado en producción (no se reabre sin regresión concreta)
R1 · PKG-00A, 00C, 00E, 00F, 00G · PKG-01A–01H · R2-A (01I–01M) · R2-B (01N–01Q) ·
PKG-02A, 02B. Qué decidió cada uno: `docs/DECISIONS_INDEX.md` → `DECISIONS.md`.
Evidencia: migraciones `supabase/migrations/`, pruebas `src/__tests__/db/`.

## Solo en local
- Nada de negocio. La arquitectura de contexto (fases 1–3: `CLAUDE.md`, este archivo,
  `docs/DECISIONS_INDEX.md`, EKKO-105…135, `.claude/skills/*`, `scripts/db-*.mjs`) se
  introduce en el cambio de contexto que contiene este archivo; si está commiteada,
  pusheada o desplegada se lee en git y Netlify, no aquí.

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
- Hook `beforeAll` de `stripe-eventos.db.test.ts` con límite por defecto (10 s).
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
Publicación de la arquitectura de contexto (fases 1–3) cuando el dueño lo autorice. Fase 4 (notas de
arquitectura) y archivo de documentos históricos: NO autorizados todavía. Ningún
paquete de remediación (02C+) está autorizado.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
