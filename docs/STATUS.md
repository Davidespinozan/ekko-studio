# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-06 · PKG-06A cerrado en producción (operaciones compuestas
de cuenta con frontera del servidor). Antes: PKG-02H (operaciones de cobro del staff
durables). Todo lo de abajo se verificó en vivo contra git, Netlify y Supabase.

## Producción (verificado 2026-10-06 04:15 UTC y re-verificado 15:51 UTC)
- Código de negocio publicado: `b12fe4f3237a7f3fb20c7bf568a6bce3e60b16ec`
  ("fix(accounts): make account composites durable", PKG-06A); el commit docs-only
  de este archivo va encima (ver `git log`). Cadena:
  `a80a8df` (contexto fase 4) → `50b880d` (PKG-02C) → `57b9af0` (link "Volver a EKKO"
  en Login) → `8d7519d` (fix `supabase.rpc` en material) → `cf7c3a0` (material
  pendiente) → `c33b750` (STATUS) → `6fe3f64` (F-1) → `762dbe4` (STATUS) → `890498a` (PKG-03A)
  → `1d42079` (STATUS) → `0890adb` (EKKO-138) → `0b23ca7` (STATUS) → `0ffe13d` (PKG-03B)
  → `07a85d8` (STATUS) → `308a4a7` (STATUS) → `f713586` (PKG-03B fase D) → `a682065` (STATUS)
  → `50c3a4c` (PKG-02H) → `82604ef` (STATUS) → `b12fe4f` (PKG-06A).
- Netlify production: deploy `6ac473f643f09e0008dc0393`, READY, `commit_ref` =
  `b12fe4f`, publicado 2026-10-06 04:09:16 UTC; 46 funciones, 9 programadas (sin
  cambio), `cron-reconciliar-stripe` a `0 9 * * *`. Antes: `6ac466413a08ae000859a132` =
  82604ef, `6ac46533…` = 50c3a4c (03:06 UTC, PKG-02H), `6ac45c84…` = a682065, `6ac45ba0…` =
  f713586 (02:25 UTC, fase D de 03B). Antes de eso:
  `6ac45875…` = 308a4a7, `6ac45790…` = 07a85d8 (reconstrucción para cargar la
  variable del reconciliador, 02:08 UTC), `6ac455aa…` = 07a85d8,
  `6ac4548d…` = 0ffe13d (01:55 UTC), `6ac44f67…` = 0b23ca7,
  `6ac44ea7…` = 0890adb (01:30 UTC), `6ac43df1…` = 1d42079,
  `6ac43c90…` = 890498a (00:12 UTC), `6ac432a4…` = 762dbe4,
  `6ac43209…` = 6fe3f64 (23:27 UTC), `6ac42df5…` = c33b750 (23:10),
  `6ac42883…` = cf7c3a0 (22:47 UTC). Cada commit anterior tuvo su deploy
  READY con su SHA exacto: `6ac419b1…` = 50b880d (21:43 UTC), `6ac41d7d…` = 57b9af0
  (22:00 UTC), `6ac42107…` = 8d7519d (22:15 UTC). El build command es
  `npm run ci:gate`: cada push a `main` dispara su propio deploy.
- Supabase: **110/110 migraciones**; última
  `20261013100000_06a_cuentas_compuestas.sql` (PKG-06A, md5
  `4cbd57a7b5ce694918fc048e314c4b1d`, aplicada 2026-10-06 ~04:03 UTC). La 109 es
  `20261012100000_02h_operaciones_staff_durables.sql` (PKG-02H). La 108 es
  `20261011100000_03b_reconciliacion_stripe.sql` (PKG-03B), la 107
  `20261010100000_ekko138_pausa_comercial.sql` (EKKO-138), la 106
  `20261009100000_03a_pendientes_operativos.sql` (PKG-03A), la 105
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
**PKG-03B "Reconciliador Stripe (detect-only)" — CLOSED IN PRODUCTION** (EKKO-140; detalle
y evidencia en la sección "PKG-03B" de abajo; primera corrida programada OBSERVADA el
2026-10-06 09:00:52 UTC: completa, 15 suscripciones leídas, 0 discrepancias) ·
**PKG-02H "Operaciones de cobro del staff durables" — CLOSED IN PRODUCTION** (EKKO-141) ·
**PKG-06A "Operaciones compuestas de cuenta" — CLOSED IN PRODUCTION** (EKKO-142,
D-FIN-1 = A; detalle en la sección "PKG-06A" de abajo).
Alcance final tras deduplicar contra R1, R2-A/B, EKKO-138, 03A y 03B: pausar, reactivar y
dar de baja al fin del periodo escriben su operación en `stripe_operaciones_suscripcion`
en la misma transacción que la transición local (causas `pausa_staff`,
`reactivacion_staff`, `baja_fin_periodo`; tipo `cancelar_fin_periodo`), con identidad por
operación lógica; `stripe-pausar-membresia` y `staff-cancelar-membresia` (fin de periodo)
pasan a RPC → ejecutor (ya no tocan Stripe antes de la intención). Evidencia
(2026-10-06 03:00–03:10 UTC): commit `50c3a4c`; migración `20261012100000` aplicada
(108 → 109, md5 `cf90c704896d40103478c0c270f1a24d`) antes del código, sin crear
operaciones (tabla con 0 filas antes y después); deploy `6ac46533fd7f11000905e896`
READY con ese SHA. Funciones 118 → 118: cambiaron exactamente `staff_pausar_membresia`,
`staff_cancelar_membresia`, `_reconciliar_cobro_sancion`, `operacion_suscripcion_preparar`
y `operacion_suscripcion_resultado`; 0 nuevas, 0 quitadas; idénticas al build probado.
Constraints `tipo`/`causa` ampliados; ACL de las 5 funciones sin cambio; sin DML de cliente
en operaciones; anon/PUBLIC 0. En las definiciones vivas: intención `pausa_comercial_at`
sigue siendo autoridad y el sync del webhook no la toca; reactivar con sanción no crea
reanudación; la sanción solo descarta sus suspensiones y no duplica reanudaciones; la
revocación va primero; la baja inmediata (R2-B) intacta; llaves
`pausar_staff:<mem>:<pausa>`, `reactivar_staff:<mem>:<pausa>`, `cancelar_fin:<mem>`.
03A: pendientes/fallidas visibles con `vigilar_operacion`/`decidir_operacion`; etiqueta
nueva publicada. 03B intacto: 9 programadas, `0 9 * * *`, manual con token (POST sin
token → 403), supresión `operacion_en_vuelo` presente. Hardening 49/49; drift 64/64;
datos de negocio intactos (foto antes = después). Local: DB 27 suites / 455 pruebas; gate
207 archivos / 1958. Sin evento artificial: ninguna pausa, reactivación, baja ni
mutación de Stripe durante la activación.
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
**EKKO-138 / D-03A-1 "Pausa comercial durable" — CLOSED IN PRODUCTION** (EKKO-138,
EKKO-139). Evidencia (2026-10-06 01:25–01:35 UTC): commit `0890adb`; migración
`20261010100000` aplicada (106 → 107, md5 `46a1bdabf4e4f2e5e376570f56c6fbab`) ANTES del
código, sin backfill (0 membresías con intención: había 0 pausadas, 0 sancionadas, 0
auditorías de pausa); deploy `6ac44ea7bb615e00082cbf73` READY con ese SHA. Funciones
116 → 116: cambiaron solo `staff_pausar_membresia`, `_reconciliar_cobro_sancion` y
`operacion_suscripcion_preparar`; 0 nuevas, 0 quitadas; idénticas al build probado.
Autorización: sin escritura de cliente sobre `membresias` (anon PATCH 401), ACL de
las 3 funciones sin cambio, anon 401 en la RPC; 02C, F-1 y 03A siguen vigentes.
Invariantes presentes en las definiciones vivas: la pausa del staff pone la
intención y la reactivación la quita (y re-asegura la sanción); el sync del webhook
no escribe `pausa_comercial_at`; levantar la sanción con intención deja la
reanudación descartada `pausa_comercial_vigente`; la revocación sigue primero.
Hardening 47/47; drift 64/64; datos intactos (hash de `membresias` sobre columnas
previas = idéntico). Gate local 202 archivos / 1896 pruebas (15/15 de EKKO-138;
suites cerradas afectadas 117/117).
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
- **PKG-06D "Frontera de columnas y de cliente" — IMPLEMENTADO LOCALMENTE, en un
  commit local SIN PUSH** (EKKO-143). Dos migraciones, NO aplicadas en producción:
  A `20261014100000_06d_a_lectura_interna_por_rpc.sql` (md5
  `ad0798d34a5ee6de13cabdbc0a9058a9`; aditiva: `staff_datos_internos_cuenta`,
  `staff_observaciones_reserva`, `buscar_cuentas_staff`) y B
  `20261014110000_06d_b_frontera_columnas.sql` (md5
  `81bf09281b2a3c8ab932d7c5d523d99f`; SELECT de `authenticated`/`anon` por columnas
  en `usuarios` —sin `notas_admin`, `sancion_motivo`, `acceso_autorizado_*`— y en
  `reservas` —sin `observaciones`, `qr_token_hash`—). ORDEN DE ACTIVACIÓN
  OBLIGATORIO: A → push/deploy → B (un cliente viejo con `select('*')` recibiría
  "permission denied" si B va antes del deploy). Cliente: ninguna lectura de
  `usuarios`/`reservas` usa `*` (`src/shared/lib/columnas.ts`); la lista del panel
  es la RPC `buscar_cuentas_staff` (texto como parámetro: FR-27); notas y
  observaciones del staff por RPC; `AuthProvider` con `errorSesion` +
  `ErrorSesion` (E-16, FR-36) en los tres layouts. Servidor: `_lib/errores.ts`
  (`errorInterno`, marca `seguro`) aplicado a 44 sitios de 20 funciones de
  navegador (FR-26); `backend.ts` solo muestra el `error` de un 5xx marcado
  `seguro`; Signup igual. `netlify.toml`: Content-Security-Policy (FR-25; script
  estricto, `'unsafe-inline'` solo en style-src, documentado) y `/*.map` → 404;
  `vite.config.ts`: `sourcemap` false en producción (FR-37). Pruebas:
  `db/06d-frontera-columnas.db.test.ts` (16; 12 muerden sin migraciones, 5 con solo
  A), `csp.test.ts` (8), `vite-config.test.ts` (3), `errores-internos.test.ts` (4),
  `AuthProvider.test.tsx` (6), `backend.test.ts` (+4), contratos de
  `useAdminData.errores` y `DetalleReservaModal` al nuevo contrato RPC. Hardening
  54/54 (antes 51); drift 68/68 (antes 66). Gate completo verde: 213 archivos / 2041
  pruebas, build OK sin ningún `.map` en `dist`, `git diff --check` OK (62 s, máquina en
  reposo; una corrida previa falló en tsc por una prueba que importaba
  `vite.config.ts` a través de la referencia de proyecto; se reescribió como prueba
  estática). Activación: pendiente de
  autorización del dueño (`ekko-activar`, en dos fases).

## PKG-06A — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06A "Operaciones compuestas de cuenta con frontera del servidor"** (EKKO-142,
  D-FIN-1 = A) — commit `b12fe4f` ("fix(accounts): make account composites durable"),
  migración `20261013100000_06a_cuentas_compuestas.sql` (md5
  `4cbd57a7b5ce694918fc048e314c4b1d`; Supabase 109 → 110), deploy Netlify
  `6ac473f643f09e0008dc0393` READY = b12fe4f (04:09 UTC). Activado 2026-10-06 en orden
  migración (aditiva) → push → deploy; ventana vieja-código/nueva-base de ~6 min, segura
  (la única conducta nueva para el código viejo: un alta contra un perfil sin acceso con
  historial ya no vincula por el correo).
- Qué quedó: FR-01, FR-02, FR-03, FR-04, FR-05, FR-06 y FR-08 CLOSED IN PRODUCTION. La
  parte LOCAL de alta (admin y recepción), cambio de rol, baja, reset de contraseña y
  edición por staff es una RPC de servicio en UNA transacción con actor explícito
  validado (`cuenta_alta_preparar`/`cuenta_alta_finalizar`, `cuenta_cambiar_rol`,
  `cuenta_eliminar`, `cuenta_password_reseteada`, `staff_actualizar_cuenta`,
  `auth_usuario_sin_perfil`, `cuenta_historial_durable`, `_cuenta_actor`,
  `_cuenta_huella_staff`, `_cuenta_avisar_cambiar_password`): 11 funciones nuevas,
  SECURITY DEFINER, `search_path=public`, dueño postgres, sin EXECUTE para
  PUBLIC/anon/authenticated, solo service_role (el actor no se forja); el actor
  validado se publica en la transacción para que `_audit_actor()` (R1, hash intacto)
  registre a la persona real. `handle_new_auth_user` es la ÚNICA función previa que
  cambió (`a2a99ce2…` → `b2a4f040…`): vincula por correo solo cascarones sin historial o
  perfiles autorizados por un staff (`usuarios.acceso_autorizado_at/por`, 2 columnas
  NULL nuevas). D-FIN-1 = A: sin borrado físico con historial durable (membresías,
  ledger, pagos, reservas, ventas, material, reversales, operaciones/discrepancias de
  Stripe, correos directos, notas, cliente de Stripe) ni huella como staff; el
  permitido deja `cuenta_eliminada` antes del DELETE, sin PII. Funciones de Netlify
  reescritas sobre `_lib/cuentas.ts` (preparar → Auth → finalizar; compensación por
  propiedad; respuesta parcial honesta; reset verdadero aunque falle la evidencia).
- Verificación: 129 funciones de aplicación (118 + 11); las 11 nuevas y la cambiada
  hash-idénticas al build local probado; las otras 117 idénticas a antes (único extra
  de producción, previo: `rls_auto_enable()`, helper gestionado). Matriz de privilegios
  verificada en vivo. Hardening 51/51; drift 66/66. Datos de negocio: hash de todas las
  tablas (usuarios con columnas previas, auth.users, membresías, movimientos, pagos,
  reservas, audit_log, operaciones, discrepancias, corridas, avisos, eventos) idéntico
  antes de migrar, después de migrar y después del deploy: CERO mutaciones de Auth, de
  negocio o de Stripe causadas por la activación; 0 filas de auditoría 06A, 0
  marcadores. Único evento natural posterior (15:51 UTC): la primera corrida programada
  del reconciliador (09:00 UTC, 03B), que solo leyó Stripe y no cambió nada más. Sondas: sitio 200; las 6 funciones responden 401 sin token y con token
  inválido antes de cualquier lógica; bundle publicado con las etiquetas y mensajes
  nuevos y sin las cadenas retiradas. Gate local 208 archivos / 1999 pruebas;
  regresión de suites cerradas 175/175; `db/06a-cuentas-compuestas` 36/36 (35 muerden
  sin la migración).
- Residuales aceptados: el CHECK de `usuarios.rol` conserva el valor legado `staff`
  (las funciones ya no lo aceptan; 0 filas); la autorización explícita de vinculación
  (`perfil_id`) existe en el servidor sin UI; el trigger de R1 sigue escribiendo su
  `cuenta_estado_cambio` junto a la fila explícita de la RPC (ambas con actor).

## PKG-03B — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-03B "Reconciliador Stripe (detect-only)"** (EKKO-140, D-03B-1 = A) —
  **FASES A, B y D CERRADAS EN PRODUCCIÓN → PKG-03B = CLOSED IN PRODUCTION; la PRIMERA
  CORRIDA PROGRAMADA NATURAL ya ocurrió (2026-10-06 09:00:52 UTC: completa, 15
  suscripciones, 0 discrepancias; leída el mismo día a las 15:51 UTC). RECONCILIADOR =
  DIARIO (09:00 UTC) + MANUAL (endpoint protegido por token).**
  **Fase D (2026-10-06 02:20–02:30 UTC):** commit `f713586`, sin migración (Supabase
  sigue en 108); deploy `6ac45ba046ad180008bf2860` READY con ese SHA; 9 funciones
  programadas, la nueva `cron-reconciliar-stripe` a `0 9 * * *`; el manual
  `reconciliar-stripe` sigue publicado y su token sigue configurado (valor nunca
  registrado); ambos usan el MISMO núcleo y la misma fachada de Stripe de solo lectura
  (`accounts.retrieve`, `subscriptions.list`); el detector no cambió. Guardas de
  solapamiento sin coordinador nuevo: una corrida cuyas lecturas son anteriores a otra
  ya asentada queda `parcial` con `superada_por_corrida_posterior` (no cierra ni abre
  con datos viejos); un choque del índice único se asienta como `parcial` con
  `conflicto_concurrente`. `cron-expirar-membresias` sin cambio. Gate local 206
  archivos / 1937 pruebas. Durante la activación NO se ejecutó ninguna reconciliación:
  sigue existiendo exactamente 1 corrida (la de fase B), 0 discrepancias; POST público a
  ambas funciones → 403; 118 funciones sin cambio; hardening 49/49; drift 64/64; datos
  de negocio sin cambio; cero mutaciones de Stripe.
  Evidencia fase A (2026-10-06 01:50–02:00 UTC): commit `0ffe13d`; migración
  `20261011100000` (107 → 108, md5 `decf6fdc14ea490f053f2300eb396bce`) antes del
  código; deploy `6ac4548dfd7f11000901f1a6` READY con ese SHA. Funciones 116 → 118:
  2 nuevas (`registrar_reconciliacion_stripe` solo service_role;
  `revisar_discrepancia_stripe` authenticated con guarda de admin y estudio), 0
  cambiadas, 0 quitadas; idénticas al build probado. `discrepancias_stripe` y
  `reconciliacion_stripe_corridas`: RLS, lectura admin de su estudio, sin DML de
  cliente, **0 filas**. `v_pendientes_operativos` sigue security_invoker con sus 2
  ramas nuevas. anon 401 en tablas, vista y RPC; sin EXECUTE de anon/PUBLIC.
  Hardening 49/49; drift 64/64; datos de negocio intactos. Gate local 205 archivos /
  1928 pruebas. Código publicado: la fachada de Stripe del reconciliador solo usa
  `accounts.retrieve` y `subscriptions.list`; Operación muestra discrepancias con
  "Marcar como revisada" y ningún botón de reparar.
  **Apagado verificado:** `RECONCILIAR_STRIPE_TOKEN` no está configurado (esta
  activación no lo configuró); `POST /reconciliar-stripe` → 403 "Reconciliación
  deshabilitada"; sin `cron-reconciliar-stripe` ni horario (8 funciones programadas,
  ninguna del reconciliador); ninguna lectura de Stripe por el reconciliador, ninguna
  corrida, ninguna mutación de Stripe.
  **Fase B (2026-10-06 02:03–02:15 UTC):** `RECONCILIAR_STRIPE_TOKEN` configurado en
  Netlify (secreto, scope functions, contexto production; el valor no se registró en
  ningún lado) y reconstrucción del mismo commit para cargarlo. Exactamente UNA
  corrida en vivo (POST autorizado, HTTP 200, 2,1 s): corrida
  `6f68cb7e-582a-4baf-ad28-406c49b823e3`, 1 estudio, **completa**, 15 suscripciones
  leídas en la cuenta conectada del estudio, **0 discrepancias** (0 por tipo), 0
  cerradas, sin error. Antes: 0 corridas, 0 discrepancias; 0 membresías de EKKO
  refieren hoy una suscripción, 0 sanciones, 0 pausas comerciales, 0 operaciones de
  cobro. Cero mutaciones de Stripe: el código publicado solo alcanza
  `accounts.retrieve` y `subscriptions.list`. Datos de negocio sin cambio. Operación:
  sigue mostrando solo los 2 pendientes reales previos (evento de Stripe en
  `revision` desde 2026-10-02 y `activo_sin_derecho`); recepción y miembro, 0.
  Hardening 49/49; drift 64/64; 118 funciones sin cambio. Nada revisado ni resuelto.
  **Evidencia natural obtenida:** la primera corrida programada (09:00:52 UTC) quedó en
  `reconciliacion_stripe_corridas` como `completa`, 15 leídas, 0 abiertas.
  Limitaciones observadas (residual menor P3, aceptado): la corrida no desglosa cuántas
  de las 15 suscripciones estaban vivas, terminadas o sin marca `app`, así que el 0 no
  se puede contrastar por estado sin volver a leer Stripe (las vivas sin marca y sin
  membresía quedan fuera del alcance probado, por diseño); y `iniciada_at` de la
  corrida es la hora de registro, no la de inicio.
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
- PKG-06A, evidencia natural (no se fabrica): primera alta real (admin o recepción),
  primer cambio de rol, primer intento de borrado (permitido o protegido), primer
  reset de contraseña y primera edición de cuenta por recepción; primera fila de
  auditoría con actor real escrita por el trigger de R1 a través de una RPC 06A.
- PKG-02H, evidencia natural (no se fabrica): primera pausa real del staff con
  suscripción, primera reactivación, primera baja al fin del periodo, primer fallo
  ambiguo del proveedor en una operación del staff.
- PKG-03A, evidencia natural (no se fabrica): primer correo que falle y se
  reintente; primer push con fallo; primera operación de cobro que agote reintentos;
  primer correo directo del webhook asentado en `correos_directos`.
- EKKO-138, evidencia natural (no se fabrica): primera pausa real del staff, primera
  reactivación, primera sanción con pausa comercial vigente y primer levantamiento
  de sanción con la pausa vigente (PENDING FIRST LEGITIMATE EVENT).
- Residuales de EKKO-138 (separados, no se resuelven de paso):
  1. Al levantar una sanción el acceso vuelve a `activo` aunque haya pausa comercial
     vigente (comportamiento previo del levantamiento; la membresía sigue en pausa
     y la divergencia `activo_sin_derecho` aparece en Operación). Acceso ≠ cobro.
  2. Si alguien reanuda el cobro directo en Stripe durante una pausa comercial, la
     intención local se conserva y el proveedor queda activo: divergencia que
     detectaría PKG-03B.
  3. (Resuelto por PKG-02H: la pausa/reactivación del staff ya es una operación
     durable con llave.)
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
Resolver desde el panel los 2 pendientes reales de Operación (evento de Stripe en `revision` desde 2026-10-02 y
`activo_sin_derecho`). El backlog canónico final (reconciliación post-R1/R2/01/02/03)
deja 7 paquetes: 06B (operaciones de cobro del miembro y del webhook), 06C (alta pública
con verificación), 06D (frontera de columnas y cliente), 06E (ciclo de vida del
material), 06F (agregación en el servidor), 06G (señales operativas durables); el
siguiente recomendado es PKG-06D. Decisiones del dueño pendientes: D-FIN-2 (DSN de
Sentry en producción: hoy no hay), D-FIN-3 (deploy previews con secretos LIVE),
D-FIN-4 (cuentas demo al salir), D-FIN-8 (2 objetos huérfanos de Storage), respaldo y
simulacro de restauración, cuál versión del enlace de Login queda (publicada vs stash).
Ningún paquete nuevo está autorizado; un backlog o una auditoría antigua no es
autorización.

## Reglas de este archivo
- Cambia solo tras verificar: IMPLEMENTADO LOCALMENTE (código + gate verde),
  COMMITTED (commit real), PUSHED (remoto verificado), MIGRACIÓN APLICADA
  (historial de producción), DEPLOYED (deploy ready con el SHA exacto),
  VERIFICADO EN PRODUCCIÓN (lectura real), CLOSED (criterios del paquete).
- Lo actualizan los skills `ekko-paquete` y `ekko-activar` al cerrar su paso, nunca
  por haber "llegado" a él. Cambios de interfaz, pruebas nuevas o refactors no lo tocan.
- Un paquete cerrado pasa a una línea de la sección "Cerrado"; su historia vive en
  `DECISIONS.md` y en git, no aquí.
