# Auditoría de Lógica de Negocio — EKKO Studio

**Fecha:** 2026-05-21
**Tipo:** Auditoría READ-ONLY (ningún archivo de código modificado)
**Alcance:** 9 áreas — reservas, estados de reserva, reprogramar, estados de
miembro, no-shows, integridad de datos, edge cases temporales, límites,
conteos/dashboards.
**Método:** 3 agentes paralelos + **verificación manual de todo CRITICAL/HIGH**
contra el código real (rigor SEC-FIX-2: varios findings de los agentes estaban
sobre-calificados y se recalibraron).
**Estado del repo:** `main`, commit `68b85ed`.

---

## ✅ ESTADO — LOGIC-FIX aplicado (2026-05-22)

El sprint **LOGIC-FIX** cerró los bloqueantes pre-launch:

| Finding | Estado | Cómo |
|---|---|---|
| L-01 horario sensible a TZ | ✅ Resuelto | `reservar_recurso_atomic` ancla el horario a `America/Mazatlan` (correcto sea cual sea la TZ de sesión) |
| L-02 check-in acepta `cancelada_admin` | ✅ Resuelto | `check_in_atomic`/`check_in_manual_atomic` rechazan todo estado ≠ `confirmada` (incluido un catch-all para estados futuros) |
| L-03 `revocado` fuera del CHECK | ✅ Resuelto | Migración versiona el `CHECK` de `usuarios.status` con `revocado` |
| L-15 QR no se invalida al cancelar | ✅ Resuelto por L-02 | `qr_token_hash` resultó columna muerta (nunca se escribe/lee); nulearla sería no-op. L-02 cierra el riesgo real: un QR de reserva cancelada ya no pasa el check-in |

Migración `20260522100000_logic_fix.sql` + `supabase/tests/logic_fix_checks.sql`.
**Pendiente operativo:** aplicar la migración, correr `logic_fix_checks.sql`,
y la prueba manual de L-01 (reservar un slot de las 18:00 Culiacán). Los 13
MEDIUM − 2 ya resueltos + 5 LOW siguen como hardening post-launch.

---

## ⚠️ RESUMEN EJECUTIVO

EKKO está **sólido en el núcleo**: los RPCs de reserva son `SECURITY DEFINER`,
validan rol/tenant/estado; `marcar_no_shows` es idempotente; `bloqueado_hasta`
se levanta solo; `pendiente_pago` es consistente en RPC/RLS/front; SEC-FIX no
rompió el frontend (nada lee `ob_data`/`stripe_customer_id` de `usuarios`); y
**no hay lógica de saldo/créditos a medias** (D4 está limpio, solo schema
preparado para Stripe).

Pero hay un **CRITICAL condicional que puede bloquear el launch** y dos HIGH
confirmados.

| Severidad | Cantidad |
|-----------|----------|
| 🔴 CRITICAL (condicional) | 1 |
| 🟠 HIGH | 2 |
| 🟡 MEDIUM | 13 |
| 🟢 LOW | 5 |
| **TOTAL** | **21** |

### 🔴 CRITICAL — verificar HOY antes que nada

**L-01 · La validación de horario del estudio depende de la timezone de la
sesión Postgres.** El RPC `reservar_recurso_atomic` compara `p_slot_inicio::time`
contra los bloques `recursos.horarios` — y `timestamptz::time` se evalúa en la
TZ de la sesión. El frontend manda instantes UTC. **Si la sesión Postgres es UTC
(el default de Supabase), los slots de la tarde-noche de Culiacán se rechazan
con `EKKO_FUERA_DE_HORARIO` aunque sean horario válido** — la mitad del día
operativo quedaría imposible de reservar. **Si la sesión es `America/Mazatlan`,
no hay bug.** No se puede determinar sin la BD: **correr `SHOW timezone;` y una
reserva de prueba a las 18:00 hora Culiacán antes de cualquier otra cosa.**

### 🟠 HIGH — confirmados, código-nivel

**L-02 · Check-in acepta reservas `cancelada_admin`.** `check_in_atomic` y
`check_in_manual_atomic` rechazan `completada/cancelada/no_show` con `IF`
positivos enumerados — pero `cancelada_admin` (estado creado en RP-1, *después*
de estas funciones) no matchea ninguno → cae al `UPDATE ... SET
status='completada'`. Una reserva cancelada por el estudio puede convertirse en
check-in válido.

**L-03 · `revocado` no existe en el `CHECK` de `usuarios.status`.**
`crudHelpers.revokeTeamMember()` escribe `status='revocado'`, pero el `CHECK`
del repo solo admite `pendiente_onboarding/pendiente_pago/activo/suspendido/
cancelado`. O la revocación de acceso de staff está rota, o la BD desplegada
tiene el `CHECK` editado a mano (drift repo↔BD). Cualquiera de los dos exige una
migración.

---

## FINDINGS DETALLADOS

> Formato: Qué está mal · Cómo se manifiesta · Confirmado (cómo) · Fix.
> Tras cada hallazgo, el Área (1-9) del scope.

---

### 🔴 L-01 — Validación de horario sensible a la timezone de sesión · Área 7 · ✅ RESUELTO (LOGIC-FIX)

- **Archivo:** `supabase/migrations/20260517000001_fix_reglas_operativas.sql:156-177`
- **Severidad:** CRITICAL *(condicional — depende del `timezone` de la sesión Postgres)*

**Qué está mal.** El RPC vigente `reservar_recurso_atomic` valida que el slot
caiga dentro de `recursos.horarios`:
```sql
v_dia_semana := CASE EXTRACT(DOW FROM p_slot_inicio)::integer ... END;
... WHERE bloque->>'dia' = v_dia_semana
    AND (bloque->>'inicio')::time <= p_slot_inicio::time
    AND (bloque->>'fin')::time   >= v_slot_fin::time
```
`p_slot_inicio` es `timestamptz`. `EXTRACT(DOW FROM …)` y `…::time` se evalúan
en la **TZ de la sesión Postgres**. El frontend (`reservaLogic.combinarFechaHora`)
arma el slot en hora local y lo manda como UTC (`.toISOString()`). Los bloques
`recursos.horarios` están en hora local de Culiacán (`"09:00"`–`"22:00"`).

Si la sesión es **UTC** (default de Supabase — no hay migración que setee
`timezone`): un slot de las 16:00 Culiacán llega como `23:00Z`; `::time` da
`23:00`; `'22:00' >= '23:00'` es falso → **`EKKO_FUERA_DE_HORARIO`**. Los slots
desde ~15:00 Culiacán en adelante se rechazan. Peor: los posteriores a las 17:00
local cruzan medianoche UTC y `EXTRACT(DOW)` devuelve el día siguiente.

**Cómo se manifiesta.** Con el seed (estudios L-V 09:00–22:00), ningún miembro
puede reservar la tarde-noche; el front sí ofrece esos slots (calcula en local)
pero el RPC los rechaza. Mitad del día operativo inutilizable.

**Confirmado.** Leí el bloque del RPC verbatim (arriba); leí `combinarFechaHora`
(`reservaLogic.ts:50-54` — `new Date(y,m-1,d,h,min)` local) y el envío UTC
(`CrearReservaModal.tsx:224`). **No verificado:** el `timezone` real de la
sesión Supabase — un `grep` de las 29 migraciones no encontró `SET timezone`,
pero Supabase puede tener la TZ configurada a nivel proyecto fuera del repo.

**Fix.** (1) **Primero verificar:** `SHOW timezone;` en el SQL editor + una
reserva de prueba a las 18:00 Culiacán. (2) Si la sesión es UTC: convertir antes
de comparar — `(p_slot_inicio AT TIME ZONE 'America/Mazatlan')` para `EXTRACT(DOW)`
y `::time`. Idealmente guardar la TZ en `tenants.config`.

---

### 🟠 L-02 — Check-in acepta reservas `cancelada_admin` · Área 2 · ✅ RESUELTO (LOGIC-FIX)

- **Archivo:** `supabase/migrations/20260514150000_perfil_extendido.sql:95-104`
  (`check_in_atomic`) y `:219-228` (`check_in_manual_atomic`)
- **Severidad:** HIGH

**Qué está mal.** Ambas funciones validan el estado con `IF` positivos:
```sql
IF v_reserva.status = 'completada' THEN RAISE ...
IF v_reserva.status = 'cancelada'  THEN RAISE ...
IF v_reserva.status = 'no_show'    THEN RAISE ...
```
No hay rama para `cancelada_admin` — estado creado en RP-1
(`20260520100000`), **posterior** a estas funciones (`20260514150000`). Una
reserva `cancelada_admin` no matchea ningún `IF` → llega al `UPDATE ... SET
status='completada'`.

**Cómo se manifiesta.** Recepción cancela la reserva de un miembro (queda
`cancelada_admin`, el miembro recibe la notificación). El miembro llega igual y
escanea su QR (que sigue válido — ver L-15). El check-in no la rechaza y la pasa
a `completada`. Fila inconsistente: `cancelada_at`/`cancelada_por` poblados **y**
`check_in_at`/`status='completada'`. Cuenta como asistencia y le da acceso.

**Confirmado.** Leí ambas funciones verbatim (`check_in_atomic` líneas 95-121,
`check_in_manual_atomic` 219-245): exactamente 3 `IF status =`, ninguno
`cancelada_admin`, y el `UPDATE` final sin más guardas. Confirmé que
`cancelada_admin` es un estado escribible (`cancelar_reserva_atomic` lo escribe).

**Fix.** Reemplazar los 3 checks positivos por uno negativo robusto:
`IF v_reserva.status != 'confirmada' THEN RAISE EXCEPTION 'EKKO_RESERVA_NO_
CHECKINEABLE: estado %', v_reserva.status;`. Un check negativo no se rompe al
agregar estados nuevos.

---

### 🟠 L-03 — `revocado` no está en el `CHECK` de `usuarios.status` · Área 4·6 · ✅ RESUELTO (LOGIC-FIX)

- **Archivo:** `supabase/migrations/20260514100200_usuarios.sql:29-31` (CHECK) ·
  `src/admin/lib/crudHelpers.ts` (`revokeTeamMember`, escribe `'revocado'`)
- **Severidad:** HIGH *(condicional — depende de si la BD desplegada tiene drift)*

**Qué está mal.** El `CHECK` de `usuarios.status` admite solo
`pendiente_onboarding, pendiente_pago, activo, suspendido, cancelado`. Ninguna
de las 29 migraciones lo amplía. Pero `revokeTeamMember()` hace
`update({ status: 'revocado' })`, y `admin-delete-user` filtra por
`.neq('status','revocado')`. `validarStatusCuenta.ts` también documenta que
`'revocado'` "no está en el enum".

**Cómo se manifiesta.** Si el repo == la BD: revocar a un miembro del equipo
falla con `violates check constraint "usuarios_status_check"` — la función IAM
de quitar acceso no funciona. Si revocar funciona en producción: la BD tiene el
`CHECK` editado a mano → drift repo↔BD (el mismo problema que RP-1 admitió que
ya pasó con `reservas.status`).

**Confirmado.** Leí el `CHECK` verbatim del repo; `grep "revocado"` en
migraciones = 0; `grep` en `src/` muestra `revokeTeamMember` escribiéndolo.
**No verificado:** el estado real del `CHECK` en la BD desplegada.

**Fix.** Migración idempotente que reemplace el `CHECK` incluyendo `'revocado'`
(mismo patrón que RP-1 usó para `reservas_status_check`). Considerar un check de
drift schema-repo↔BD.

---

### 🟡 MEDIUM

**L-04 — Falta `EXCLUDE` constraint; el handler de colisión fue removido.**
*(Área 1)* — `reservar_recurso_atomic` detecta slot ocupado con
`SELECT EXISTS(... tstzrange && ...)`. **El índice único parcial
`reservas_unique_slot_per_recurso (recurso_id, slot_inicio) WHERE status IN
('confirmada','completada')` SÍ existe** → para el modelo real de EKKO (slots de
60 min en grilla, `cupos=1`) **la doble-reserva del mismo slot está prevenida
por la BD** aun con requests concurrentes. El hueco residual: (a) un solape
*parcial* con `slot_inicio` distinto (solo posible si las duraciones varían —
hoy siempre `duracion_default_min`) no lo cubre el índice point-match; (b) las
versiones del RPC posteriores a `20260514100900` **perdieron el bloque
`EXCEPTION WHEN unique_violation`** → cuando el índice sí dispara, el miembro ve
un error crudo `23505` en vez de `EKKO_SLOT_OCUPADO` traducido. **Fix:** agregar
`EXCLUDE USING gist (recurso_id WITH =, tstzrange(slot_inicio,slot_fin,'[)')
WITH &&) WHERE status IN ('confirmada','completada')` — la extensión `btree_gist`
ya está instalada para esto y nunca se usó. Restaurar el `EXCEPTION` handler.
*(Recalibrado de CRITICAL: el índice único cubre el modelo 1:1 vigente.)*

**L-05 — `reservar_para_miembro_atomic` permite reservar en el pasado.**
*(Área 1)* — `recepcion_plus_rp1.sql:47-180`. Por D1 recepción salta
`min_anticipacion_horas` (correcto para walk-ins), pero al hacerlo se perdió el
único filtro que incidentalmente bloqueaba el pasado, y no hay un
`p_slot_inicio >= now()` explícito. No es alcanzable por la UI (el date picker
arranca hoy) pero sí por llamada directa al RPC de un recepcionista/admin.
Efecto en cadena: `marcar_no_shows` penalizaría esa reserva pasada. `reservar_
recurso_atomic` tiene el mismo gap si `anticipacion_min_horas=0`. **Fix:**
`IF p_slot_inicio < v_now THEN RAISE 'EKKO_SLOT_PASADO'`.

**L-06 — `reservar_para_miembro_atomic` no valida el horario del recurso.**
*(Área 1)* — `reservar_recurso_atomic` (miembro) valida `recursos.horarios` y
emite `EKKO_FUERA_DE_HORARIO`; `reservar_para_miembro_atomic` (recepción) **no
tiene ese bloque**. Recepción puede reservar a cualquier hora / en días sin
horario. La UI lo evita (la grilla solo ofrece slots válidos), pero el RPC —
fuente de verdad — no se autodefiende. Inconsistencia entre dos RPCs gemelos.
**Fix:** portar el bloque de validación de horario. *(Nota: arreglar esto sin
arreglar L-01 propaga el bug de TZ; van juntos.)*

**L-07 — Folio con `count(*)+1`: race + retrocede + sin UNIQUE.** *(Área 1)* —
`fix_reglas_operativas.sql:215`. El folio se genera `'EKK-'||(count(*)+1)`. Dos
inserts concurrentes calculan el mismo folio; al cancelar reservas el `count`
baja y se reusan folios. `reservas.folio` no tiene `UNIQUE`. La secuencia
`reservas_folio_seq` quedó creada y huérfana. **Fix:** volver a
`nextval('reservas_folio_seq')` + `UNIQUE (tenant_id, folio)`.

**L-08 — `usuarios_datos_privados` nunca recibe filas nuevas.** *(Área 6 ·
SEC-FIX)* — SEC-FIX creó la tabla y migró las filas existentes, pero ningún
código inserta filas nuevas: ni el trigger `handle_new_auth_user` ni las 3
Netlify Functions de creación la tocan. Hoy no rompe nada (nada la lee). Pero
cuando se construya el onboarding, un `UPDATE usuarios_datos_privados SET
ob_data=…` afectará 0 filas en silencio. **Fix:** que `handle_new_auth_user`
inserte la fila hermana, o que toda escritura futura sea `INSERT … ON CONFLICT
DO UPDATE`.

**L-09 — `database.ts` desactualizado tras SEC-FIX.** *(Área 6 · SEC-FIX)* — los
tipos generados todavía declaran `ob_data`/`stripe_customer_id` en `usuarios`
(SEC-FIX las dropeó) y no incluyen la tabla `usuarios_datos_privados`. No hay
bug activo (nada lee esas columnas), pero es una trampa latente — TS deja
escribir `usuario.ob_data` y en runtime sería error. **Fix:** regenerar con
`supabase gen types`.

**L-10 — Sin máquina de estados de miembro: admin puede dejar `activo` sin
tier.** *(Área 4)* — `MiembroDetalle.tsx` cambia `status` con un `<select>`
libre (5 estados) y `updateMiembro` hace un `UPDATE` directo. Nada valida
transiciones ni la coherencia `status`↔`tier`. Un admin puede poner `activo` a
un miembro con `membresia_tier = NULL` → figura activo en toda la UI pero
`reservar_recurso_atomic` lo rechaza con `EKKO_TIER_NO_PERMITIDO`: no puede
reservar nada. **Fix:** validar que `status='activo'` exige `membresia_tier IS
NOT NULL`.

**L-11 — Hard-delete de recurso: guard no atómica.** *(Área 6)* —
`canHardDeleteRecurso` cuenta reservas y `hardDeleteRecord` hace el `DELETE`
aparte (TOCTOU). `reservas.recurso_id` es `ON DELETE RESTRICT` → no hay
huérfanos, pero si entra una reserva entre el count y el delete, el usuario ve
un error FK crudo sin traducir. **Fix:** count + delete en un RPC transaccional.

**L-12 — `cálculo de slots del cliente depende de la TZ del navegador.**
*(Área 7)* — `combinarFechaHora`/`diaNombre` usan `new Date(...)` y `getDay()`
locales. Si un recepcionista/admin opera con el equipo en otra TZ (viaje,
laptop mal configurada), un slot rotulado "14:00" se graba en otro instante.
Para un userbase 100% en Culiacán el impacto es acotado. **Fix:** anclar el
cálculo a `America/Mazatlan` explícito. Misma raíz que L-01.

**L-13 — Regla "continuas": cliente vs RPC divergen con duraciones variables.**
*(Área 7)* — el cliente (`reservaLogic.ts:121-128`) detecta continuas con
`slotInicio ± duracion` asumiendo duración fija; el RPC compara `slot_fin/
slot_inicio` reales. Coinciden mientras `duracion_default_min` sea constante; si
una reserva tiene otra duración, el cliente puede mostrar disponible un slot que
el RPC rechaza (o al revés). UX confusa, no pérdida de datos. **Fix:** alinear
el cliente a comparar fin/inicio reales.

**L-14 — Reprogramar pisa `duracion_min` con el default actual.** *(Área 3)* —
`CrearReservaModal.tsx:190` pasa `config.duracion_default_min` al reprogramar;
no recibe la duración de la reserva original. Una reserva de 90 min reprogramada
queda de 60. **Fix:** propagar `duracion_min` original en la prop
`ReservaOriginal`. *(Relacionado: en `debeCancelarPrimero`, `nuevo.fin` usa la
duración default mientras `original.fin` usa el `slot_fin` real → la heurística
de orden puede equivocarse si las duraciones difieren; recuperable —
`error_crear`, no pérdida de datos.)*

**L-15 — El QR no se invalida al cancelar/reprogramar.** · ✅ RESUELTO (LOGIC-FIX, vía L-02) *(Área 2·3)* — ninguna
transición de cancelación toca `qr_token_hash`. Combinado con L-02, el QR de una
reserva `cancelada_admin` sirve para hacer check-in. **Fix:** `qr_token_hash =
NULL` en `cancelar_reserva_atomic` (ambas ramas). Arreglar junto con L-02.

**L-16 — Conteos del dashboard inconsistentes entre sí.** *(Área 9)* — tres
problemas confirmados leyendo `useAdminData.ts`: (a) `useDashboardData` cuenta
`no_show` como reserva en "reservas de hoy/del mes" (filtra solo `cancelada` y
`cancelada_admin`); (b) `useAdminMetrics` excluye `cancelada` pero **no**
`cancelada_admin` → infla `reservasEsteMes` y la ocupación; (c) hay **tres
definiciones distintas** de "reservas de hoy" entre `useAdminMetrics`,
`useDashboardData` y `useReservasHoy`. Es inexactitud de reporte, no corrupción.
**Fix:** un helper único de "reserva activa" (`confirmada`+`completada`) reusado
en todos los hooks.

---

### 🟢 LOW

- **L-17 — `admin-delete-user` no pre-chequea `check_in_by`/`cancelada_por`.**
  *(Área 6)* Esas FKs a `usuarios(id)` no tienen `ON DELETE` → default `RESTRICT`.
  Borrar un recepcionista que históricamente hizo check-ins falla con un error FK
  crudo no contemplado por los pre-checks. **Fix:** pre-check, o `ON DELETE SET
  NULL` (preserva auditoría).

- **L-18 — Dos definiciones de "último admin".** *(Área 4)* La guard de revocar
  usa `count_admins_activos` (`status='activo'`); `admin-delete-user` usa
  `.neq('status','revocado')` (incluye suspendidos). Un tenant podría quedar sin
  admin operativo. **Fix:** unificar en "admin operativo = `status='activo'`".

- **L-19 — `ocupacion7d` con denominador hardcodeado.** *(Área 9)*
  `SLOTS_DISPONIBLES_7D = 13*3*7` ignora los horarios reales por día (sáb/dom son
  más cortos) y recursos agregados/inactivos → % de ocupación sesgado. **Fix:**
  calcular desde `recursos` activos × sus `horarios`.

- **L-20 — `marcar_no_shows` sin reintento ni alerta.** *(Área 5)* Si el cron
  horario falla, los no-shows no se marcan y nadie se entera. (La evasión por
  auto-cancelación está cerrada: `cancelar_reserva_atomic` rechaza reservas
  pasadas.) **Fix:** monitoreo del cron.

- **L-21 — Bug muerto en migración `20260514160000`.** *(Área 1)* Esa versión de
  `reservar_recurso_atomic` inserta en una columna `cupos` ya renombrada a
  `invitados_count`. Sin efecto — `20260517000001` es el `CREATE OR REPLACE`
  vigente. Solo evidencia de fragilidad del historial de migraciones.

---

## A CONFIRMAR (dudoso — NO afirmado como bug)

- **AC-1 · No hay límite de reservas por miembro.** Ningún RPC limita cuántas
  reservas activas/futuras tiene un miembro (solo anticipación y "no
  continuas"). Un miembro podría acaparar slots. **Pero esto puede ser
  intencional** — es una decisión de producto, no un bug. Si se quiere tope,
  agregar `tiers.reglas.max_reservas_activas`. Reportado para decisión, no como
  defecto.

- **AC-2 · `cancelarReserva` (frontend) no usa el RPC.** `crudHelpers.ts`
  cancela con un `UPDATE` directo vía RLS en vez de `cancelar_reserva_atomic` →
  omite las validaciones del RPC (`status='confirmada'`, slot futuro) y duplica
  la notificación. No es un agujero de seguridad (RLS protege el tenant) pero es
  una vía paralela inconsistente con el RPC endurecido en SEC-FIX. Podría ser
  intencional (admin con poder total). A confirmar con producto.

- **AC-3 · Reprogramar no es atómico (D6).** `reprogramarReserva.ts` hace
  cancelar+crear en dos RPCs; el path `parcial_sin_recrear` deja al miembro sin
  reserva. **Es una decisión de diseño explícita y documentada**, con aviso al
  usuario por toast — no un bug. Pero es un punto de fragilidad real: si en la
  ventana entre cancelar y crear un tercero toma el slot, el miembro pierde su
  reserva y depende de que recepción lea el toast. La solución de fondo sería un
  RPC `reprogramar_reserva_atomic` único. Se reporta como deuda conocida.

- **AC-4 · `max_invitados` hardcodeado en `Reservar.tsx`.** El cliente topa
  invitados en `pro=4/basica=2` hardcoded; el RPC lee `tiers.reglas->>'max_
  invitados'` (configurable). El backend valida bien (no es un agujero), pero la
  UI miente si el admin cambia el límite. A confirmar si vale arreglarlo
  pre-launch.

---

## CONSISTENCIA TRAS SEC-FIX (verificación especial)

- ✅ **El frontend NO se rompió.** `grep` exhaustivo: ningún código lee
  `usuario.ob_data` ni `usuario.stripe_customer_id` de la entidad `usuarios`
  (solo `database.ts` — tipos — y un comentario en `PerfilMiembroRecepcion`).
  El claim de SEC-FIX "`SELECT *` sigue funcionando, cero cambios de frontend"
  se sostiene.
- ✅ **El onboarding no usa `ob_data`.** No hay flujo que lo escriba/lea — no hay
  nada roto porque no hay nada construido aún.
- ⚠️ **`usuarios_datos_privados` nunca recibe filas** → L-08 (trampa para el
  futuro onboarding).
- ⚠️ **`database.ts` quedó stale** → L-09.

---

## PLAN DE FIXES PRIORIZADO

### 🔴 Verificar HOY (antes de cualquier fix)
- **L-01** — correr `SHOW timezone;` en la BD de EKKO + una reserva de prueba a
  las 18:00 Culiacán. Si la sesión es UTC → es CRITICAL y bloquea el launch
  (medio día operativo no reservable); arreglar el RPC. Si es `America/Mazatlan`
  → no hay bug, pero conviene anclar la TZ explícitamente igual.

### 🟠 Bloqueante pre-launch
- **L-02** — check-in robusto (`!= 'confirmada'`). Quick, alto impacto.
- **L-03** — migración para `revocado` en el `CHECK` (o confirmar el drift).
- **L-15** — invalidar `qr_token_hash` al cancelar (junto con L-02).

### 🟡 Recomendado pre-launch (rápidos, evitan datos sucios)
- L-05 (reservar en el pasado), L-06 (horario en el RPC de recepción),
  L-10 (activo sin tier), L-16 (conteos del dashboard).

### 🟢 Post-launch / hardening
- L-04 (EXCLUDE constraint), L-07 (folio), L-08/L-09 (deuda SEC-FIX),
  L-11, L-12, L-13, L-14, L-17 … L-21.

### Decisiones de producto (no bugs)
- AC-1 (límite de reservas), AC-3 (reprogramar atómico), AC-4 (max_invitados UI).

---

## LO QUE ESTÁ BIEN (verificaciones positivas confirmadas)

- **`marcar_no_shows` es idempotente** — marca cada reserva una sola vez (filtra
  `status='confirmada'` y lo primero que hace es cambiarlo); `no_shows_count` no
  se infla.
- **`bloqueado_hasta` se levanta solo** — los RPCs comparan `> now()`, no hay que
  "limpiarlo"; pasada la fecha el miembro puede reservar de nuevo.
- **`pendiente_pago` es consistente** en las 3 capas (RPC exige `activo`, login
  lo bloquea, front lo marca).
- **`bloqueado_hasta` se chequea en ambos RPCs de reserva**, además del `status`.
- **No hay lógica de saldo/créditos a medias (D4)** — `grep` de
  `saldo/credito/sesiones_restantes` = 0; la sección "Dinero" del dashboard está
  deshabilitada. Schema preparado para Stripe, sin deuda parcial.
- **El índice único `reservas_unique_slot_per_recurso`** previene la doble-reserva
  del mismo slot en el modelo 1:1 vigente.
- **`cancelar_reserva_atomic`** valida `status='confirmada'` y slot futuro con
  checks negativos robustos — no tiene el problema de L-02.

---

*Fin de la auditoría de lógica. Próxima sugerida de la serie: rendimiento /
queries N+1, o UX de estados límite y manejo de errores.*
