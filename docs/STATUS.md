# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-06 · PKG-03A cerrado en producción (pendientes
operativos y entrega). Antes: F-1 (vistas de valor aisladas). Todo lo de abajo se
verificó en vivo contra git, Netlify y Supabase.

## Producción (verificado 2026-10-06 00:20 UTC)
- Código de negocio publicado: `890498add89e2b728efd85e1f3e8a294ac86741a`
  ("feat(operations): add durable operational pending workflow", PKG-03A); el
  commit docs-only de este archivo va encima (ver `git log`). Cadena:
  `a80a8df` (contexto fase 4) → `50b880d` (PKG-02C) → `57b9af0` (link "Volver a EKKO"
  en Login) → `8d7519d` (fix `supabase.rpc` en material) → `cf7c3a0` (material
  pendiente) → `c33b750` (STATUS) → `6fe3f64` (F-1) → `762dbe4` (STATUS) → `890498a` (PKG-03A).
- Netlify production: deploy `6ac43c905e3475000842d63f`, READY, `commit_ref` =
  `890498a`, publicado 2026-10-06 00:12:49 UTC. Antes: `6ac432a4…` = 762dbe4,
  `6ac43209…` = 6fe3f64 (23:27 UTC), `6ac42df5…` = c33b750 (23:10),
  `6ac42883…` = cf7c3a0 (22:47 UTC). Cada commit anterior tuvo su deploy
  READY con su SHA exacto: `6ac419b1…` = 50b880d (21:43 UTC), `6ac41d7d…` = 57b9af0
  (22:00 UTC), `6ac42107…` = 8d7519d (22:15 UTC). El build command es
  `npm run ci:gate`: cada push a `main` dispara su propio deploy.
- Supabase: **106/106 migraciones**; última
  `20261009100000_03a_pendientes_operativos.sql` (PKG-03A). La 105 es
  `20261008100000_f1_vistas_valor_security_invoker.sql` (F-1), la 104
  `20261007100000_material_pendiente_y_requerido.sql` y la 103
  `20261006100000_02c_frontera_rest_avisos_y_grants.sql` (PKG-02C), aplicadas.
- Datos de negocio (lectura 23:04 UTC, sin PII): **1 membresía activa** (alta manual
  por staff con referencia de pago, 21:53 UTC; sin suscripción de Stripe), 1 expirada,
  4 canceladas; **1 reserva futura** confirmada (creada 22:00 UTC para el 2026-10-07,
  `material_requerido = true`), 12 `no_show` históricas; 2 filas en `material_sesion`
  (22:16 y 22:27 UTC); 0 sancionados/revocados; 0 notas; 0 avisos `cambiar_password`.
  Último evento de webhook de Stripe: 2026-10-02. Stripe en modo live (cuenta de
  plataforma compartida; EKKO filtra por cuenta conectada y `metadata.app`).
  Son los PRIMEROS eventos reales de uso tras el programa de remediación: la
  checklist `VALIDACION_PRIMER_USO.md` ya tiene material para empezar.

## Cerrado en producción (no se reabre sin regresión concreta)
R1 · PKG-00A, 00C, 00E, 00F, 00G · PKG-01A–01H · R2-A (01I–01M) · R2-B (01N–01Q) ·
PKG-02A, 02B · Arquitectura de contexto fases 1–4 (PUBLICADA / VALIDADA / CERRADA) ·
**PKG-02C "Frontera de autorización por REST: avisos, notas y grants" — CLOSED IN
PRODUCTION** (EKKO-136). Evidencia de la activación (2026-10-05 21:36–21:50 UTC):
commit `50b880d` publicado; migración `20261006100000` aplicada (102 → 103); deploy
`6ac419b10edc0a00075d8db0` READY con ese SHA; policies de `notificaciones` = 2
(SELECT/UPDATE propios, UPDATE con WITH CHECK, sin INSERT por REST); 3 funciones y 3
triggers nuevos (incluido `on_auth_user_password_changed` sobre `auth.users`);
101/101 funciones preexistentes con hash idéntico; anon y PUBLIC sin DML ni EXECUTE
en funciones de aplicación; authenticated sin DML donde ninguna policy escribe y
sin TRUNCATE, con sus 44 EXECUTE intactos; hardening 43/43; drift 64/64; datos de
negocio intactos (foto antes = después = final). Residual conductual, NO bloqueante:
`PENDING FIRST LEGITIMATE PASSWORD CHANGE` (ningún aviso `cambiar_password` existía
ni se fabricó; el trigger se verificó por estructura y por pruebas locales) ·
**F-1 "Vistas de valor aisladas" (hotfix de seguridad) — CLOSED IN PRODUCTION.**
Hallazgo de la auditoría de confiabilidad operativa (2026-10-05): `valor_por_lote` y
`movimientos_sin_vinculo` (de 20261002100000) se evaluaban con permisos del dueño
(salta RLS), sin filtro de tenant y con SELECT para anon: la llave pública leía el
agregado del ledger de valor (7 filas seudónimas, sin nombres ni correos). Cierre
(2026-10-05 23:24–23:28 UTC): commit `6fe3f64`; migración `20261008100000` aplicada
(104 → 105, md5 `1386c71f52f7149fd0501a6d7ae14db8`); deploy `6ac432095e347500081e187d`
READY con ese SHA; ambas vistas `security_invoker=true`; ACL = postgres y service_role
sin cambio, authenticated solo SELECT, sin anon ni PUBLIC; GET anónimo por REST →
401 en ambas; en transacciones de solo lectura revertidas, un admin activo ve solo
su tenant (0 filas de otro) y recepción ve 0 (antes 7); 106/106 funciones con hash
idéntico; hardening 45/45 (2 checks P5 nuevos); drift 64/64; sin datos tocados.
Gate local 197 archivos / 1836 pruebas. Producción tiene un solo tenant: el
aislamiento entre tenants con datos reales queda probado en PGlite
(`f1-vistas-valor.db.test.ts`), no con datos de producción.
**PKG-03A "Pendientes operativos y entrega" — CLOSED IN PRODUCTION** (EKKO-137).
Evidencia (2026-10-06 00:05–00:20 UTC): commit `890498a`; migración `20261009100000`
aplicada (105 → 106, md5 `ffd683f4900c94ef82ccbaa61b3179be`) ANTES del código; deploy
`6ac43c905e3475000842d63f` READY con ese SHA. Funciones 106 → 116: cambiaron solo
`notificaciones_frontera_cliente` (02C, lista blanca) y `operacion_suscripcion_resultado`
(R2-B, tope de 5 intentos por ronda); 10 nuevas, ninguna quitada; idénticas a la base
local probada. Objetos: ciclo de vida de correo/push en `notificaciones`,
`correos_directos`, cierre humano en `stripe_webhook_events`, tope y RPC de
reintentar/descartar en `stripe_operaciones_suscripcion`, `v_pendientes_operativos`
(security_invoker), página `/admin/operacion` y tarjeta en el Centro de pendientes.
Autorización: RPC de entrega solo service_role; RPC de admin con guarda interna; sin
EXECUTE de anon/PUBLIC; anon 401 en vista, tabla y RPC nuevas. La vista, leída como el
admin real (transacción de solo lectura revertida), deriva justo el trabajo real
esperado: el evento de Stripe en `revision` desde 2026-10-02 y una divergencia
`activo_sin_derecho`; recepción y miembro ven 0. Hardening 47/47; drift 64/64; datos
de negocio intactos (hash de `notificaciones` y `stripe_webhook_events` sobre las
columnas previas = idéntico al de antes). Gate local 201 archivos / 1878 pruebas.
D-03A-1 / EKKO-138: BLOQUEADA, NO implementada (ver "Diferido").
Qué decidió cada uno: `docs/DECISIONS_INDEX.md` → `DECISIONS.md`.
Evidencia: migraciones `supabase/migrations/`, pruebas `src/__tests__/db/`.

## Publicado después de PKG-02C (otra sesión, 2026-10-05 tarde)
Estados derivados de git, Netlify y Supabase; no son paquetes del programa de
remediación y su cierre formal lo decide el dueño.
- `57b9af0` **Login: enlace "Volver a EKKO"** — COMMITTED / PUSHED / DEPLOYED
  (incluido en el deploy activo). Sin migración. OJO: el stash
  `pre-pkg-00f-local-ui-tests` contiene una solución DISTINTA al mismo pendiente (el
  enlace debajo de la tarjeta; la publicada va arriba). El dueño decide cuál queda.
- `8d7519d` **fix `supabase.rpc` sin ligar en `src/shared/lib/material.ts`** (rompía
  todas las subidas de material desde que se desplegó) — COMMITTED / PUSHED /
  DEPLOYED (22:15 UTC). Evidencia conductual real: las 2 filas de `material_sesion`
  se crearon a las 22:16 y 22:27 UTC, después de ese deploy; antes no había ninguna.
- `cf7c3a0` **"Material pendiente de entregar"** (`reservas.material_requerido`
  default TRUE + RPC `staff_marcar_material_requerido(uuid,boolean)` y
  `staff_listar_material_pendiente()` + pendiente en el dashboard + toggle en
  check-in y perfil) — COMMITTED / PUSHED / MIGRACIÓN APLICADA (103 → 104) /
  DEPLOYED (`6ac42883…`, SHA exacto) / VERIFICADO EN PRODUCCIÓN por estructura:
  columna presente; las 2 RPC existen con EXECUTE para authenticated y denegado a
  anon y PUBLIC; 0 funciones preexistentes cambiadas (106 funciones de aplicación =
  104 tras 02C + 2 nuevas); policies/constraints/triggers/índices sin cambio;
  conteos de `reservas` por status iguales antes y después (el comparador marcó DIFF
  en `reservas` solo por la columna nueva). Comportamiento en vivo del toggle y del
  pendiente: sin verificar todavía (no bloqueante). Pruebas:
  `src/__tests__/db/material-pendiente.db.test.ts` y las de frontend del commit.

## Solo en local
- **EKKO-138 / D-03A-1 "Pausa comercial durable"** (EKKO-138, EKKO-139) —
  COMMITTED en local (un commit, ver `git log`), gate verde, SIN PUSH / SIN DEPLOY
  / MIGRACIÓN NO APLICADA. Migración `20261010100000_ekko138_pausa_comercial.sql`
  (columna `membresias.pausa_comercial_at`, sin backfill). Cambian de cuerpo a
  propósito `staff_pausar_membresia` (R1), `_reconciliar_cobro_sancion` y
  `operacion_suscripcion_preparar` (R2-B); `stripe-pausar-membresia` no reanuda
  Stripe durante una sanción. Pruebas: `src/__tests__/db/ekko138-pausa-comercial.db.test.ts`.
- (Corrección histórica: la versión anterior de este archivo, dentro del commit
  `890498a`, decía "SIN COMMIT"; se escribió antes de commitear. PKG-03A ya está
  publicado y cerrado, ver "Cerrado en producción".)

## Escritor único
Un solo agente o sesión escribe en este árbol a la vez; las demás son de solo lectura.
Antes de commit/push/deploy se re-verifica HEAD, origin/main, árbol y lo stageado; una
deriva sin explicar detiene todo. El 2026-10-05 pasó dos veces (un commit ajeno a
medio paquete y una edición ajena de este archivo sin commitear): ambas se
resolvieron deteniendo y reconciliando, nunca con rebase ni merge automático.

## Estado local que se preserva
- Stash `pre-pkg-00f-local-ui-tests` (3 archivos: enlace "Volver a EKKO" en Login y
  dos pruebas). No se aplica, no se borra, no se commitea. Ver nota de `57b9af0`.

## Diferido / pendiente no bloqueante
- PKG-03A, evidencia natural (no se fabrica): primer correo que falle y se
  reintente; primer push con fallo; primera operación de cobro que agote reintentos;
  primer correo directo del webhook asentado en `correos_directos`.
- **D-03A-1 / EKKO-138:** implementada en LOCAL (ver "Solo en local"); en
  producción sigue sin estar. Hasta activarla: levantar una sanción reanuda el
  cobro aunque el staff haya pausado, y reactivar durante una sanción reanuda Stripe.
- Al levantar una sanción el acceso vuelve a `activo` aunque haya pausa comercial
  vigente (comportamiento previo del levantamiento; la membresía sigue en pausa y
  la divergencia `activo_sin_derecho` aparece en Operación). No se cambió: acceso ≠
  intención de cobro.
- `PENDING FIRST LEGITIMATE PASSWORD CHANGE` (PKG-02C): el primer cambio real de
  contraseña de un usuario con aviso `cambiar_password` abierto debe cerrarlo; hoy no
  hay ningún aviso de ese tipo. No se fabrica.
- Validación con el PRIMER evento real (sin fabricar nada): pago live, staff, sanción,
  revocación, cancelación tardía, revisiones financieras. Checklist:
  `VALIDACION_PRIMER_USO.md`. Ya ocurrieron los primeros: alta manual de membresía,
  reserva futura y subida de material (2026-10-05 noche).
- Verificación en vivo del fix de material de `46ecd0a` (limpieza del objeto de
  Storage si falla el registro) y del toggle/pendiente de `cf7c3a0`.
- Credencial de la cuenta demo: riesgo aceptado por el dueño. NO remediar.

## Residuales conocidos (para paquetes posteriores; no corregir de paso)
- Storage: 2 objetos huérfanos en el bucket `material` (del 2026-10-04, sin fila en
  `material_sesion`; 4 objetos en total). Sin tocar. Pendiente de decisión del dueño.
- Finanzas: no se guardan comisiones de Stripe; ventas de mostrador sin evidencia de
  anulación; `stripe_price_id` sin uso; default de 2 invitados en
  `reservas_incompatibles_con_tier`.
- Si staff reanuda a mano una membresía pausada por sanción, el cobro vuelve.
- Carrera intermitente en `usePlanesActivos.test.tsx` (PKG-02A; 1 fallo en 17 gates),
  sin tocar. `sentry-lib.test.ts` (5 s) puede expirar bajo carga; aislado pasa.
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
Revisión del dueño y activación controlada de EKKO-138 (commit local). En Operación hay trabajo real
esperando una decisión del dueño: el evento de Stripe en `revision` desde 2026-10-02
y una divergencia `activo_sin_derecho`. PKG-03B no está autorizado.
Pendientes previos — decisiones del dueño: cierre formal de los tres trabajos de material/Login, cuál
versión del enlace de Login queda (publicada vs stash) y qué hacer con los 2 objetos
huérfanos de Storage. Después, el siguiente bloque del programa (resto del E — admin —
o Fase 2 de identidad). Ningún paquete nuevo está autorizado; un backlog o una
auditoría antigua no es autorización.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
