# STATUS — EKKO (estado operativo)

Foto de conveniencia, no evidencia. Si contradice a producción, git, las
migraciones o las pruebas, manda la realidad: repórtalo y corrige este archivo.
Solo se actualiza después de VERIFICAR la transición (ver "Reglas" abajo).

Última actualización: 2026-10-06 · PKG-06E cerrado en producción (ciclo de vida del
material; FR-42..46). Antes: PKG-06C (alta pública con correo verificado; FR-24). Todo lo de
abajo se verificó en vivo contra git, Netlify y Supabase.

## Producción (verificado 2026-10-06 19:16 UTC)
- Código de negocio publicado: `6b2e086a2e9f079a612940459ac9f78a5a6e7ea8`
  ("fix(material): make storage lifecycle recoverable", PKG-06E); el commit docs-only
  de este archivo va encima (ver `git log`). Cadena:
  `a80a8df` (contexto fase 4) → `50b880d` (PKG-02C) → `57b9af0` (link "Volver a EKKO"
  en Login) → `8d7519d` (fix `supabase.rpc` en material) → `cf7c3a0` (material
  pendiente) → `c33b750` (STATUS) → `6fe3f64` (F-1) → `762dbe4` (STATUS) → `890498a` (PKG-03A)
  → `1d42079` (STATUS) → `0890adb` (EKKO-138) → `0b23ca7` (STATUS) → `0ffe13d` (PKG-03B)
  → `07a85d8` (STATUS) → `308a4a7` (STATUS) → `f713586` (PKG-03B fase D) → `a682065` (STATUS)
  → `50c3a4c` (PKG-02H) → `82604ef` (STATUS) → `b12fe4f` (PKG-06A) → `c02532b` (STATUS)
  → `fdecdbb` (PKG-06D) → `06d27b8` (STATUS) → `3649842` (PKG-06G) → `cf1cfc0` (STATUS)
  → `33b44d2` (PKG-06B) → `6d456a4` (STATUS) → `7927fb5` (PKG-06C) → `13d2d11` (STATUS)
  → `6b2e086` (PKG-06E).
- Netlify production: deploy `6ac5480b642ade0008efd97d`, READY, `commit_ref` =
  `6b2e086`, publicado 2026-10-06 19:14:26 UTC; 47 funciones, las 9 programadas sin
  cambio (`netlify.toml` intacto). Antes `6ac5424b7e7cd40008d8ff0a` = 13d2d11,
  `6ac540f8e7755100085bc98d` = 7927fb5 (18:44:11 UTC, PKG-06C; +`alta-publica`,
  `fake-signup` inerte con 410), `6ac53720ff4a4f00081dd047` = 6d456a4, `6ac535d7ff4a4f00081d51eb` =
  `33b44d2`, publicado 2026-10-06 17:56:34 UTC; antes `6ac52f4a4ccb810008ff86b9` =
  cf1cfc0, `6ac52e61c8b49900079d0b0c` = 3649842 (17:24:35 UTC, PKG-06G); 46 funciones, 9 programadas con los
  mismos horarios, `cron-reconciliar-stripe` a `0 9 * * *`; cabeceras con
  Content-Security-Policy. Antes: `6ac524403b4a4b00082c707b` = 06d27b8,
  `6ac52294893a0e0008a43504` = fdecdbb (16:34 UTC, PKG-06D), `6ac51926…` = c02532b, `6ac473f643f09e0008dc0393` =
  b12fe4f (04:09 UTC, PKG-06A), `6ac466413a08ae000859a132` =
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
- Supabase: **116/116 migraciones**; última
  `20261018100000_06e_ciclo_material.sql` (PKG-06E, md5
  `24aa22fac47895fb3c50c9e23e77545c`, aplicada 2026-10-06 19:11 UTC, ANTES del
  deploy); la 115 es `20261017100000_06c_alta_publica_verificada.sql` (PKG-06C, md5
  `0949ae3beed41862afdaf47bedf65b5d`, aplicada 2026-10-06 18:41 UTC, ANTES del
  deploy); la 114 es `20261016100000_06b_operaciones_cobro_miembro.sql` (PKG-06B, md5
  `91e48dea5680ba8fe400265494f639dd`, aplicada 2026-10-06 ~17:50 UTC, ANTES del
  deploy); la 113 es `20261015100000_06g_senales_operativas.sql` (PKG-06G, md5
  `fe98902ddb41caa69ececaaea4a98d28`, aplicada 2026-10-06 ~17:21 UTC); la 112 es
  `20261014110000_06d_b_frontera_columnas.sql` (PKG-06D B, md5
  `81bf09281b2a3c8ab932d7c5d523d99f`, aplicada 2026-10-06 ~16:40 UTC, DESPUÉS del
  deploy); la 111 es `20261014100000_06d_a_lectura_interna_por_rpc.sql` (PKG-06D A,
  md5 `ad0798d34a5ee6de13cabdbc0a9058a9`, aplicada ~16:28 UTC, ANTES del deploy); la
  110 es `20261013100000_06a_cuentas_compuestas.sql` (PKG-06A, md5
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
D-FIN-1 = A; detalle en la sección "PKG-06A" de abajo) ·
**PKG-06D "Frontera de columnas y de cliente" — CLOSED IN PRODUCTION** (EKKO-143;
detalle en la sección "PKG-06D" de abajo) ·
**PKG-06G "Señales operativas durables" — CLOSED IN PRODUCTION** (EKKO-144; detalle en
la sección "PKG-06G" de abajo) ·
**PKG-06B "Operaciones de cobro del miembro y del webhook" — CLOSED IN PRODUCTION**
(EKKO-145; FR-15/16/17; detalle en la sección "PKG-06B" de abajo) ·
**PKG-06C "Alta pública con correo verificado" — CLOSED IN PRODUCTION** (EKKO-146;
FR-24; D-FIN-6 = A; detalle en la sección "PKG-06C" de abajo) ·
**PKG-06E "Ciclo de vida del material" — CLOSED IN PRODUCTION** (EKKO-147; FR-42..46;
detalle en la sección "PKG-06E" de abajo).
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
Nada.

## PKG-06E — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06E "Ciclo de vida del material"** (EKKO-147, FR-42..46) — commit `6b2e086`
  ("fix(material): make storage lifecycle recoverable"), migración
  `20261018100000_06e_ciclo_material.sql` (md5 `24aa22fac47895fb3c50c9e23e77545c`;
  Supabase 115 → 116, 19:11 UTC), deploy Netlify `6ac5480b642ade0008efd97d` READY =
  6b2e086 (19:14 UTC). Orden: migración (aditiva; el código viejo seguía igual) → push
  → deploy.
- Qué quedó: FR-42, FR-43, FR-44, FR-45 y FR-46 CLOSED IN PRODUCTION. El estado de
  negocio es la fila (`eliminado_at` = acceso terminado; `disponible_hasta` = vigencia)
  y manda primero; el de limpieza se DERIVA fila ↔ `storage.objects` (bucket
  `material`, carpeta del estudio; SQL sobre metadatos: sin listar por API, sin
  paginación, sin escaneo parcial), sin tabla ni columnas nuevas. `material_limpieza_pendiente`
  (nueva, solo service_role, search_path fijo, rutas de la base): lo retirado/vencido
  cuyo objeto sigue; `cron-material-vencido` conserva el barrido de 7 días y además
  borra por tandas de 100 todo lo pendiente; un fallo queda pendiente para la siguiente
  corrida y 06G registra `fallo` (todo falló) o `parcial` (algo falló) con clase
  `almacenamiento` (sin segundo latido ni fila de proceso nueva; horario intacto).
  `staff_eliminar_material` idempotente (misma ruta, sin otra auditoría); el navegador
  revisa el resultado del borrado y avisa "se borrará en la limpieza automática"; la
  subida no muestra el texto del proveedor y la limpieza compensatoria revisa su
  resultado. `staff_listar_material_pendiente`: sesión `completada`, que requiere
  material y NUNCA recibió ninguno (lo vencido, barrido o retirado no vuelve; una
  pasada sin check-in no cuenta). Operación (solo admin, su estudio, sin rutas, sin
  botones de reintentar/borrar): `material_sin_archivo` (por material),
  `material_limpieza_atascada` (> 2 días, agregada) y `material_objeto_huerfano`
  (> 1 h, agregado). Acceso del miembro sin cambios (D-FIN-5 no requerido).
- Verificación: 141 funciones en producción (140 + `material_limpieza_pendiente`);
  cambiaron solo `staff_eliminar_material(uuid)` (d7f4462d… → 12140984…) y
  `staff_listar_material_pendiente()` (c122d66e… → e73134c8…), las 3 idénticas al
  build local probado; ninguna otra cambió. Vista security_invoker, sin anon; grants
  como antes. Hardening 62/62 y drift 75/75 en producción. Operación antes → después:
  admin 2 → 3 (+1 `material_objeto_huerfano`: "2 archivos sin material registrado ·
  592 KB" = los 2 huérfanos conocidos del 2026-10-04, intactos); recepción y miembro 0.
  Material pendiente 0 → 0. Filas de material (2 vivas con su objeto), objetos (4),
  huérfanos (2), proceso del cron, auditoría (25) y los 14 hashes de negocio idénticos
  antes, tras migrar y al final. Bundle: textos nuevos presentes, "No se pudo subir el
  archivo: " ausente, RPC de limpieza solo en el servidor; sondas: RPC de limpieza con
  la llave anónima 401, `material_sesion` anónima vacía, cron por URL 403 (no corrió).
  Gate local: 223 archivos / 2201 pruebas.
- Cero objetos de Storage borrados, filas de material modificadas, huérfanos
  borrados, retiros/vencimientos/limpiezas manuales o mutaciones de negocio causadas
  por la activación. D-FIN-8 sin cambio.

## PKG-06C — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06C "Alta pública con correo verificado"** (EKKO-146, FR-24, D-FIN-6 = A) —
  commit `7927fb5` ("fix(auth): verify email before public signup identity"),
  migración `20261017100000_06c_alta_publica_verificada.sql` (md5
  `0949ae3beed41862afdaf47bedf65b5d`; Supabase 114 → 115, 18:41 UTC), deploy Netlify
  `6ac540f8e7755100085bc98d` READY = 7927fb5 (18:44 UTC). Orden: migración (aditiva;
  el `fake-signup` viejo crea cuentas confirmadas y seguía igual) → push → deploy.
- Qué quedó: FR-24 CLOSED IN PRODUCTION. Sin correo verificado no hay identidad EKKO:
  `handle_new_auth_user` regresa sin crear ni vincular mientras
  `email_confirmed_at` sea NULL, es idempotente por cuenta de Auth y corre también en
  el trigger nuevo `on_auth_user_confirmed` (solo en la transición NULL → confirmado).
  Reglas de 06A intactas (vincular solo cascarón o perfil autorizado, sin reescribir
  rol/status/plan; ambiguo o con historial sin autorizar = se rechaza la confirmación
  entera); el alta pública nunca vincula un perfil de staff; el perfil nuevo nace
  `miembro` / `pendiente_pago` con el plan solo si sigue en venta, auditado como
  `alta_publica_verificada` (y `origen` en `auth_vinculado`). `fake-signup` retirado
  (410, sin Supabase). `alta-publica`: solo lee nombre, correo, plan y aceptación;
  cuenta de Auth SIN confirmar ni contraseña; enlace generado por el proveedor
  (`generateLink`) y enviado por el remitente de EKKO en Resend (sin tocar la cola de
  notificaciones; el token no se guarda, no se registra ni es llave de idempotencia);
  respuesta neutra única ("Si el correo puede usarse para una cuenta nueva…"); 429
  genérico; 503 honesto si el proveedor no aceptó el correo. Límite durable en
  `alta_publica_intentos` (solo huellas HMAC, RLS sin políticas, sin grants a clientes,
  purga a 24 h) vía `alta_publica_solicitar` (solo service_role, search_path fijo,
  estudio y plan del servidor): correo 1/min y 5/día (excedido = silencio), origen
  `x-nf-client-connection-ip` (IPv6 por /64; `x-forwarded-for` ignorado) 5/10 min y
  20/día, estudio 60/h. `/signup` ya no pide contraseña ni inicia sesión;
  `/confirmar-correo` verifica una vez (`verifyOtp`), quita el token de la URL, pide la
  contraseña DESPUÉS de probar el buzón y cierra la sesión si se abandona. Auth sin
  cambios: `disable_signup = true` (debe seguir así), autoconfirm encendido (irrelevante
  con el registro directo apagado), sin inicio de sesión sin verificar.
- Verificación: 140 funciones en producción (139 + `alta_publica_solicitar`); cambió
  solo `handle_new_auth_user()` (b2a4f040… → 6516fefc…), ambas idénticas al build
  local probado; ninguna otra cambió (R1, 02C, F-1, R2-B, 02H, 03A, 03B, 06A, 06B, 06D,
  06G intactas). Hardening 60/60 y drift 74/74 en producción (tras migrar y tras
  publicar). Cuentas de Auth (7, todas confirmadas), perfiles, vínculos, roles,
  membresías, auditoría (25), Operación por rol y los 14 hashes de datos de negocio
  idénticos antes, tras migrar y al final; 0 intentos. Bundle publicado: `alta-publica`
  y textos nuevos presentes, `fake-signup` y los campos de contraseña ausentes, sin
  llaves; sondas sin datos reales: `fake-signup` 410, `alta-publica` {} 400 y GET 405,
  `/signup` y `/confirmar-correo` 200. Gate local: 221 archivos / 2164 pruebas.
- Cero altas reales, cuentas de Auth, correos de verificación, cambios a cuentas demo,
  cambios de configuración de Auth, mutaciones de Stripe o de negocio causadas por la
  activación.

## PKG-06B — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06B "Operaciones de cobro del miembro y del webhook"** (EKKO-145) — commit
  `33b44d2` ("fix(billing): make member and webhook stripe operations durable"),
  migración `20261016100000_06b_operaciones_cobro_miembro.sql` (md5
  `91e48dea5680ba8fe400265494f639dd`; Supabase 113 → 114), deploy Netlify
  `6ac535d7ff4a4f00081d51eb` READY = 33b44d2 (17:56 UTC). Orden: migración (aditiva;
  el código viejo no usa los tipos ni las RPC nuevas) → push → deploy → verificación.
- Qué quedó: FR-15, FR-16 y FR-17 CLOSED IN PRODUCTION.
  - FR-15 (cambio de plan): `cambiar-plan-suscripcion` asienta la intención
    (`cambio_plan_registrar`, operación `cambiar_plan`) ANTES de tocar Stripe; si no
    puede asentarla, Stripe no se toca. Todo desenlace cierra la operación
    (`cambio_plan_resultado`): `aplicada` solo si la membresía ya tiene el tier
    destino; `descartada` sin efecto/cobro fallido/pago no iniciable; `fallida`
    (resultado desconocido, conflicto, cuenta restringida, base pendiente) queda
    visible en Operación como "revisar_cambio_plan". El ejecutor y el reintento del
    staff NO re-ejecutan un cambio de plan (lo ejecuta el miembro).
  - FR-16 (renovación del miembro): `stripe-cancelar-suscripcion` llama a
    `miembro_programar_renovacion` (actor del JWT; revocado, sancionado al reactivar
    y baja programada por el estudio se rechazan) que en UNA transacción fija
    `cancel_at_period_end` en EKKO, crea la operación y audita; luego el ejecutor
    común la lleva a Stripe. Si Stripe falla, la intención queda y la respuesta dice
    `stripe_pendiente` (la app lo dice al miembro).
  - FR-17 (suscripción anterior en el webhook): antes de activar la nueva membresía
    se registra una operación por cada suscripción anterior
    (`registrar_cancelacion_suscripcion_anterior`; ajena → error); si no puede
    registrarla, el evento falla y Stripe lo reintenta. Después el ejecutor la cancela;
    mientras no se aplique, Operación la muestra con severidad ALTA ("posible doble
    cobro") y el cron diario la reintenta.
  - `stripe_operaciones_suscripcion.contexto` es `jsonb NOT NULL DEFAULT '{}'` (el
    reporte de implementación lo llamó nullable por error; la migración y producción
    dicen NOT NULL).
- Verificación: 139 funciones (135 + 4 nuevas); cambiaron solo
  `operacion_suscripcion_preparar`, `operacion_suscripcion_resultado` y
  `staff_reintentar_operacion_cobro`; las 7 idénticas por hash al build local
  probado; ninguna otra cambió (R1, 02C, F-1, R2-B, 02H, 03A, 03B, 06A, 06D, 06G
  intactas). Privilegios: las 3 RPC de servicio solo service_role; la del miembro solo
  authenticated; ninguna con anon/PUBLIC; `search_path=public`. Vista security_invoker;
  Operación por rol igual antes y después (admin: evento en revisión y
  activo_sin_derecho; recepción y miembro: 0). Hardening 58/58 y drift 72/72 en
  producción. Los 14 hashes de datos de negocio idénticos antes, tras migrar y tras el
  deploy; 0 operaciones; webhook procesado:48 / revision:1 sin eventos nuevos. Bundle
  publicado con los textos nuevos y sin sourcemaps; funciones sin token 401 y webhook
  sin firma 400; las 9 programadas con los mismos horarios. Pruebas: DB 24 (22 muerden
  sin la migración), regresión 181/181, gate 217 archivos / 2116 pruebas.
- Cero mutaciones de Stripe, webhooks, eventos de cobro, auth o negocio causadas por la
  activación.

## PKG-06G — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06G "Señales operativas durables"** (EKKO-144) — commit `3649842`
  ("fix(ops): make scheduled process failures durable"), migración
  `20261015100000_06g_senales_operativas.sql` (md5 `fe98902ddb41caa69ececaaea4a98d28`;
  Supabase 112 → 113), deploy Netlify `6ac52e61c8b49900079d0b0c` READY = 3649842
  (17:24 UTC). Orden: migración (aditiva; el código viejo no registra y la ventana de
  primera corrida absorbe el despliegue) → push → deploy → verificación.
- Qué quedó: FR-50 y FR-51 CLOSED IN PRODUCTION. Las 9 funciones programadas siguen
  con sus horarios. `procesos_programados` (estado actual, sin Sentry) vigila 6:
  `cron-expirar-membresias` (26 h, alta, 1 fallo) y `cron-no-shows` (3 h, alta, 2) como
  continuidad crítica; `cron-email` (20 min, media, 5), `cron-push` (15 min, media, 10),
  `cron-recordatorios` (1 h, media, 3) y `cron-material-vencido` (26 h, media, 1).
  `cron-reconciliar-stripe` no tiene fila: su atraso (>26 h) se deriva de
  `reconciliacion_stripe_corridas` (03B intacto, detect-only, sin otra ejecución).
  `cron-membresias-por-vencer` y `cron-felicitaciones` (cortesía) quedan fuera a
  propósito. Cada cron vigilado asienta su corrida AL TERMINAR por
  `registrar_ejecucion_proceso` (solo service_role; exito / parcial / fallo / omitido,
  clase de error fija, sin texto crudo). El atraso y los fallos seguidos se DERIVAN al
  leer `v_pendientes_operativos` (security_invoker, ramas previas idénticas + 4 tipos
  nuevos: proceso_atrasado, proceso_fallando, reconciliacion_atrasada,
  push_no_entregado); un cron muerto se ve sin reportarse; ventana de primera corrida
  max(umbral, 2 h). Push: `fallo`/`sin_config` agregados por estudio vía
  `resumen_fallos_push` (sin destinatario, contenido, endpoint ni llaves; la política
  de avisos sigue con 3 políticas) y revisables con nota (`revisar_fallos_push`, admin,
  audit). Sin "correr ahora" ni auto-reparación. Límite aceptado: no hay alarma
  externa; la detección ocurre al abrir Operación o el Centro de pendientes.
- Verificación: 135 funciones (132 + 3), ninguna previa cambió (R1, 02C, F-1, R2-B,
  02H, 03A, 03B, 06A, 06D intactas por hash), las 3 nuevas idénticas al build probado;
  matriz de privilegios en vivo (registrar: solo service_role; revisar/resumen: sin
  PUBLIC/anon). Hardening 56/56; drift 70/70. Operación leída como admin, recepción y
  miembro reales en transacciones revertidas: el admin ve solo los 2 pendientes reales
  previos; recepción y miembro, 0. Bundle publicado con las etiquetas nuevas, el botón
  de revisar push con nota y sin control de "correr". Datos de negocio: 14 tablas
  idénticas antes y después (avisos idénticos en sus 21 columnas previas; solo se
  agregaron 2 columnas NULL): CERO mutaciones causadas por la activación; CERO
  corridas manuales, fallos de push artificiales, cambios de Auth o de Stripe.
  Evidencia natural: `cron-push` asentó su primera corrida real (`exito`, 17:25:13 UTC)
  y `cron-email` también (`exito`, 17:26:05 UTC); los demás esperan su horario. Gate local 215 archivos / 2070 pruebas (una corrida previa falló en el
  intermitente preexistente `ekko138` 5b, sin tocar).
- Residuales aceptados: sin alarma proactiva externa; crons de cortesía sin vigilar;
  los recursos de Supabase y Netlify no se vigilan desde fuera.

## PKG-06D — cerrado en producción (detalle; la línea corta está en "Cerrado")
- **PKG-06D "Frontera de columnas y de cliente"** (EKKO-143) — commit `fdecdbb`
  ("fix(security): harden client data boundary"), activado 2026-10-06 en DOS FASES
  obligatorias: migración A `20261014100000_06d_a_lectura_interna_por_rpc.sql` (md5
  `ad0798d34a5ee6de13cabdbc0a9058a9`; Supabase 110 → 111; aditiva: RPC
  `staff_datos_internos_cuenta`, `staff_observaciones_reserva`,
  `buscar_cuentas_staff`, SECURITY DEFINER con guardia `is_recepcionista()` + tenant,
  sin EXECUTE para PUBLIC/anon) → push y deploy Netlify `6ac52294893a0e0008a43504`
  READY = fdecdbb (16:34 UTC) → compuerta pre-B sobre el bundle publicado (0
  `select('*')` en usuarios/reservas, listas de columnas explícitas, 3 RPC presentes,
  0 `.or()` de búsqueda, 0 `select()` con columnas revocadas, `sin_perfil`/ErrorSesion
  y contrato `seguro` publicados, 0 source maps, CSP viva idéntica a la probada) →
  migración B `20261014110000_06d_b_frontera_columnas.sql` (md5
  `81bf09281b2a3c8ab932d7c5d523d99f`; Supabase 111 → 112; solo REVOKE/GRANT). Para
  aplicar A sola, B se apartó del directorio durante el push y se restauró (árbol
  limpio verificado antes de cualquier commit).
- Qué quedó: FR-34, FR-25, FR-26, FR-27, FR-37 y FR-36/E-16 CLOSED IN PRODUCTION.
  Frontera de columnas: `authenticated` y `anon` tienen SELECT por columnas —22 en
  `usuarios` (sin `notas_admin`, `sancion_motivo`, `acceso_autorizado_*`), 26 en
  `reservas` (sin `observaciones`, `qr_token_hash`)—; verificado en vivo que cada
  columna interna y `*` responden "permission denied" para authenticated y anon, que
  UPDATE (incl. `notas_admin` del admin) y service_role siguen intactos y que ninguna
  vista de public expone esas columnas. El staff lee lo interno por RPC; el panel
  busca por `buscar_cuentas_staff` (texto como parámetro). Errores: `errorInterno`
  (marca `seguro`) en 44 sitios de 20 funciones de navegador; `backend.ts` y Signup
  solo muestran el `error` de un 5xx marcado `seguro`. CSP en producción (script-src
  'self' + Stripe.js; connect-src Supabase + API de Stripe; frame-ancestors 'none';
  'unsafe-inline' solo en style-src), X-Frame-Options/nosniff/Referrer/Permissions
  intactos. Source maps: el deploy publica 0 `.map` y el bundle no trae
  `sourceMappingURL`. Hidratación: `errorSesion` (carga / sin_perfil) con Reintentar
  y Cerrar sesión en los tres layouts.
- Verificación: 132 funciones de aplicación (129 + 3), las 3 nuevas hash-idénticas al
  build local; ninguna función previa cambió (02C, F-1, R1, R2-B, 02H, 03A, 03B, 06A
  intactas por hash). Hardening 54/54; drift 68/68 (con los checks de 06D; la versión
  previa daba 51/51 y 66/66 antes de A). Datos de negocio: hash de 14 tablas idéntico
  antes de A, después de A, después del deploy y después de B: CERO mutaciones de
  Auth, de negocio o de Stripe causadas por la activación; 0 eventos artificiales. Las
  6 funciones sondeadas responden 401 sin token. Gate local 213 archivos / 2041
  pruebas; base 29 archivos / 507; `db/06d-frontera-columnas` 16/16 (12 muerden sin
  migraciones, 5 con solo A).
- Residuales aceptados: `style-src 'unsafe-inline'` (documentado en `netlify.toml`);
  al activar Sentry (D-FIN-2) hay que añadir su host de ingest a `connect-src`; las
  funciones programadas, el webhook y el reconciliador conservan sus mensajes (sin
  navegador); el host de Supabase está fijo en la CSP y en seis URLs de imagen; la
  nota del admin se escribe por REST (lectura por RPC); el tipo generado de
  `reservas` va atrasado respecto a la tabla (casts en los llamadores); la regla
  `/*.map` → 404 queda sombreada por el `/*` de `public/_redirects` (una petición a un
  `.map` inexistente devuelve el shell HTML con 200, nunca un mapa).

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
- PKG-06E, evidencia natural (no se fabrica): primer retiro real con su borrado (o su
  limpieza pendiente y la convergencia en la siguiente corrida del cron), primera
  corrida registrada de `cron-material-vencido` y primer vencimiento barrido.
- PKG-06C, evidencia natural (no se fabrica): la primera alta pública real — enlace de
  `generateLink` para una cuenta sin confirmar → correo aceptado por Resend →
  `verifyOtp` → `email_confirmed_at` → `on_auth_user_confirmed` → perfil
  `pendiente_pago` + `alta_publica_verificada` → contraseña → pago. Sin probar en
  producción a propósito; no bloquea el cierre.
- PKG-06B, evidencia natural (no se fabrica): primer cambio de plan real con su
  operación cerrada; primera baja o reactivación real del miembro por la RPC y el
  ejecutor (y, si ocurre, un `stripe_pendiente` real); primer checkout con suscripción
  anterior que registre y cancele su operación.
- PKG-06G, evidencia natural (no se fabrica): primera corrida registrada de
  `cron-no-shows`, `cron-recordatorios`, `cron-expirar-membresias` y
  `cron-material-vencido`; primer proceso atrasado o fallando real; primer push no
  entregado real y su revisión.
- PKG-06D, evidencia natural (no se fabrica): primer miembro real que entra con el
  cliente nuevo (hidratación por columnas), primera búsqueda real del panel por la RPC,
  primera lectura de notas/observaciones del staff por RPC, primer 5xx real
  enmascarado, primera violación de CSP (si la hubiera) observada en el navegador.
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
- HALLAZGO NUEVO (fuera del backlog canónico; revisión del dueño antes de salir en
  vivo): Supabase Auth no tiene SMTP propio (`smtp_host` vacío; el remitente por
  defecto limita a 2 correos/h y no garantiza entrega a clientes), así que el correo de
  recuperación de contraseña (`/recuperar`, `resetPasswordForEmail`) puede no llegar a
  clientes reales. No verificado con un envío real; no se tocó en 06C.
- PKG-06C: el tiempo de respuesta puede insinuar si un correo ya tiene cuenta (crear
  tarda más que no hacer nada); el tope diario por correo lo puede agotar un tercero
  (la persona espera un día o va a recepción); el techo de 60/h del estudio puede
  saturarse ante un ataque distribuido; si aparece un perfil entre la solicitud y el
  clic, la confirmación se rechaza y la persona va a recepción.
- Storage: 2 objetos huérfanos en el bucket `material` (del 2026-10-04, sin fila en
  `material_sesion`; 4 objetos en total). Sin tocar. Desde PKG-06E se ven en Operación
  como UN renglón `material_objeto_huerfano`; EKKO no los borra. Pendiente de decisión
  del dueño (D-FIN-8).
- Finanzas: no se guardan comisiones de Stripe; ventas de mostrador sin evidencia de
  anulación; `stripe_price_id` sin uso; default de 2 invitados en
  `reservas_incompatibles_con_tier`.
- Si staff reanuda a mano una membresía pausada por sanción, el cobro vuelve.
- Intermitente en `db/ekko138-pausa-comercial.db.test.ts` caso 5b (orden de
  operaciones con marcas de tiempo empatadas; falla ~1 de 3 corridas aisladas con y sin
  06G), sin tocar.
- Carrera intermitente en `usePlanesActivos.test.tsx` (PKG-02A; 1 fallo en 17 gates),
  sin tocar. `sentry-lib.test.ts` (5 s) puede expirar bajo carga; aislado pasa.
- 2 usuarios con caché de plan divergente (evidencia de que el caché no decide).

## Siguiente paso
Resolver desde el panel los 2 pendientes reales de Operación (evento de Stripe en `revision` desde 2026-10-02 y
`activo_sin_derecho`). El backlog canónico final (reconciliación post-R1/R2/01/02/03)
deja 1 paquete (06B, 06C y 06E cerrados; ya no quedan P0, P1 ni P2; quedan 5 P3):
06F (agregación en el servidor); es el siguiente recomendado.
Aparte, el hallazgo nuevo del correo de recuperación sin SMTP propio (ver
"Residuales") requiere revisión del dueño antes de salir en vivo. Decisiones del dueño pendientes: D-FIN-2 (DSN de
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
