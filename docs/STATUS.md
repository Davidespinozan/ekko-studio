# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-05 (tarde) · corregido tras una deriva real: este
archivo decía "PKG-02C sin push" cuando ya estaba PUSHED y su migración APLICADA
en producción (otra sesión lo hizo sin pasar por aquí). Ver "Escritor único".

## Producción (verificado 2026-10-05, tarde)
- `origin/main` = `8d7519d` ("fix(material): bind supabase.rpc call so
  staff_registrar_material actually runs"). Cadena desde la foto anterior:
  `a80a8df` (fase 4) → `50b880d` (PKG-02C, otra sesión) → `57b9af0` (link "Volver a
  EKKO" en Login) → `8d7519d`. Los 3 últimos commits y su push sí pasaron por esta
  sesión.
- Deploy de Netlify: NO verificado desde aquí en esta pasada (el `netlify status`
  lo bloqueó el modo automático de esta sesión). El build command de Netlify es
  `npm run ci:gate`, así que un push a `main` dispara su propio deploy; no hay un
  paso de "deploy" manual distinto. Pendiente confirmar en el dashboard.
- Supabase: **103/103 migraciones**, última `20261006100000_02c_frontera_rest_avisos_y_grants.sql`
  — esta migración de PKG-02C SÍ está aplicada (confirmado con el registro Y con
  los objetos reales del esquema: los 3 triggers nuevos existen, la policy vieja
  de notificaciones ya no). La migración `20261007100000` (paquete nuevo de abajo)
  NO está aplicada.
- Datos de negocio: sin reverificar en esta pasada; última foto (temprano
  2026-10-05) tenía 0 membresías vivas, 0 reservas futuras.

## Cerrado en producción (no se reabre sin regresión concreta)
R1 · PKG-00A, 00C, 00E, 00F, 00G · PKG-01A–01H · R2-A (01I–01M) · R2-B (01N–01Q) ·
PKG-02A, 02B · Arquitectura de contexto fases 1–4 (PUBLICADA / VALIDADA / CERRADA) ·
PKG-02C "Frontera de autorización por REST" — PUSHED y MIGRACIÓN APLICADA (ver
arriba); falta solo VERIFICAR EN PRODUCCIÓN el comportamiento en vivo (no bloqueante)
antes de marcarlo CLOSED del todo. Decisión EKKO-136.
Qué decidió cada uno: `docs/DECISIONS_INDEX.md` → `DECISIONS.md`.
Evidencia: migraciones `supabase/migrations/`, pruebas `src/__tests__/db/`.

## Solo en local
- **"Material pendiente de entregar"** (señal `reservas.material_requerido` +
  pendiente en el dashboard + toggle en check-in y en el perfil del miembro) —
  IMPLEMENTADO LOCALMENTE, gate verde (196 archivos / 1831 pruebas), SIN COMMIT /
  SIN PUSH / SIN DEPLOY / MIGRACIÓN NO APLICADA.
  Migración `20261007100000_material_pendiente_y_requerido.sql` (aditiva: columna
  nueva default TRUE + 2 funciones nuevas, ninguna función existente cambia).
  Pruebas: `src/__tests__/db/material-pendiente.db.test.ts` (10, muerden sin la
  migración), más pruebas de frontend en `useCentroPendientes`, `centroPendientes`,
  `Miembros`, `CheckInDetail` y `FilaReserva`.
  Además, en esta misma sesión: bug real encontrado y corregido en
  `src/shared/lib/material.ts` (`supabase.rpc` se llamaba sin ligar — rompía el
  100% de las subidas de material desde que se desplegó, no solo casos raros) —
  ESE fix ya está COMMITTED, PUSHED (`8d7519d`); su comportamiento en producción
  no se ha verificado en vivo todavía.

## Escritor único
Un solo agente o sesión escribe en este árbol a la vez; las demás son de solo lectura.
Antes de commit/push/deploy se re-verifica HEAD, origin/main, árbol y lo stageado; una
deriva sin explicar detiene todo (ya pasó una vez el 2026-10-05).

## Estado local que se preserva
- Stash `pre-pkg-00f-local-ui-tests` (3 archivos: enlace "Volver a EKKO" en Login y
  dos pruebas). No se aplica, no se borra, no se commitea.
  OJO: ya se publicó una versión DISTINTA de ese mismo link (`57b9af0`, esta
  sesión) sin saber del stash — la del stash va DEBAJO de la tarjeta a propósito
  ("arriba estorbaba y era lo primero que se veía"); la publicada va ARRIBA. Son
  dos soluciones al mismo pendiente; el dueño decide cuál se queda.

## Diferido / pendiente no bloqueante
- Validación con el PRIMER evento real (sin fabricar nada): pago live, staff, sanción,
  revocación, cancelación tardía, revisiones financieras. Checklist:
  `VALIDACION_PRIMER_USO.md`.
- Credencial de la cuenta demo: riesgo aceptado por el dueño. NO remediar.

## Residuales conocidos (para paquetes posteriores; no corregir de paso)
- Resueltos por PKG-02C y YA en producción (migración aplicada): INSERT/UPDATE de
  notificaciones, rol del autor de notas, EXECUTE de anon/PUBLIC, grants por
  defecto. Falta solo verificar el comportamiento en vivo (no bloqueante).
- Finanzas: no se guardan comisiones de Stripe; ventas de mostrador sin evidencia de
  anulación; `stripe_price_id` sin uso; default de 2 invitados en
  `reservas_incompatibles_con_tier`.
- Si staff reanuda a mano una membresía pausada por sanción, el cobro vuelve.
- Carrera intermitente en `usePlanesActivos.test.tsx` (PKG-02A; 1 fallo en 17 gates),
  sin tocar. `sentry-lib.test.ts` (5 s) puede expirar bajo carga; aislado pasa.
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
PKG-02C ya está pushed y su migración aplicada (ver arriba): falta verificar su
comportamiento en vivo. El paquete "Material pendiente de entregar" está
implementado localmente con gate verde: falta la autorización del dueño para
commit → push → aplicar su migración → deploy (pasos separados). Ningún otro
paquete está autorizado; un backlog o una auditoría antigua no es autorización.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
