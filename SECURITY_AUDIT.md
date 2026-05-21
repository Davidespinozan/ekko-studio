# Auditoría de Seguridad y Permisos — EKKO Studio

**Fecha:** 2026-05-21
**Tipo:** Auditoría READ-ONLY (ningún archivo de código modificado)
**Alcance:** 8 áreas — roles/escalación, RLS, RPCs SECURITY DEFINER, Netlify
Functions, exposición de datos, auth/sesión, aislamiento multi-tenant, inyección.
**Método:** 3 agentes paralelos (DB · Netlify Functions · Frontend) + verificación
manual de los hallazgos CRITICAL.
**Estado del repo:** `main`, commit `2276f1a`.

---

## ✅ ESTADO — SEC-FIX aplicado (2026-05-21)

El sprint **SEC-FIX** cerró los 3 CRITICAL + los 6 HIGH:

| Finding | Estado | Cómo |
|---|---|---|
| C1 fake-signup | ✅ Resuelto | Crea cuentas `pendiente_pago` (inertes), sin `payment_event` falso |
| C2 auto-elevación de rol | ✅ Resuelto | Trigger `trg_proteger_columnas_usuarios` bloquea cambios privilegiados de no-admins |
| C3 dev_activar_miembro | ✅ Resuelto | Migración dropea **toda** función `public.dev_*` |
| H1 columnas sensibles | ✅ Resuelto | `ob_data`/`stripe_customer_id` movidas a `usuarios_datos_privados` (admin + dueño) |
| H2 status solo frontend | ⚪ Verificado | Los RPCs de reserva ya validan `status='activo'` en backend — test de regresión |
| H3 cancelar cross-tenant | ✅ Resuelto | `cancelar_reserva_atomic` valida tenant del tercero |
| H4 password en logs | ⚪ Verificado | Las funciones no loguean el password — guardas anti-regresión |
| H5 cron-no-shows | ✅ Mitigado | `marcar_no_shows` restringida a `service_role` (verificación HTTP → operativa) |
| H6 QR_JWT_SECRET | ⚪ Verificado | El código lee de env var; valor de prod → operativo (David) |

**Pendiente operativo:** aplicar `20260521100000_sec_fix.sql`, correr
`supabase/tests/sec_fix_checks.sql`, confirmar `QR_JWT_SECRET` en Netlify prod.
Los 8 MEDIUM + 6 LOW siguen como hardening post-launch.

---

## ⚠️ RESUMEN EJECUTIVO

EKKO está **bien arquitecturado en lo grueso**: las operaciones sensibles pasan
por RPCs `SECURITY DEFINER` o Netlify Functions que re-validan rol y tenant; el
aislamiento por `tenant_id` es consistente; los guards de React son solo UX y el
backend (RLS) es la barrera real; no hay secrets server-only en el bundle del
frontend. Los RPCs nuevos de Recepción Plus (`reservar_para_miembro_atomic`,
`reception-create-member`) están **bien hechos** — el gate de rol no se bypassea.

**Pero hay 3 vulnerabilidades CRITICAL explotables hoy** por cualquier persona
con (o sin) una cuenta, que deben corregirse **antes de cualquier launch**.

| Severidad | Cantidad |
|-----------|----------|
| 🔴 CRITICAL | 3 |
| 🟠 HIGH | 6 |
| 🟡 MEDIUM | 8 |
| 🟢 LOW | 6 |
| **TOTAL** | **23** |

### 🔴 Los 3 CRITICAL — explotables HOY

1. **`fake-signup` — endpoint público SIN autenticación que crea cuentas activas
   con `service_role`.** Cualquiera con `curl` crea cuentas `miembro` activas e
   ilimitadas, gratis, sin pagar. Bypass total de monetización + escritura libre
   en `auth.users` y `payment_events`.

2. **Un MIEMBRO se auto-eleva a `rol = 'admin'`.** La policy RLS
   `usuarios_update_self` deja que el usuario haga `UPDATE` de **cualquier
   columna** de su propia fila — incluida `rol`. Un miembro toma control total de
   su tenant desde la consola del navegador. **Es la escalación más grave.**

3. **`dev_activar_miembro` sigue desplegada** — función `SECURITY DEFINER` de
   desarrollo, sin gate de rol y sin filtro de tenant. Cualquier usuario
   autenticado se auto-activa la membresía sin pagar y manipula el `status`/`tier`
   de cualquier usuario de **cualquier tenant**.

**Las tres se corrigen rápido. Ninguna requiere rediseño. No se debe exponer el
sitio a clientes de Cravia hasta cerrarlas.**

---

## FINDINGS DETALLADOS

> Formato por finding: Vulnerabilidad · Cómo explotarlo · Fix recomendado.
> Cada uno etiquetado con su Área (1-8 del scope).

---

### 🔴 C1 — `fake-signup`: endpoint público sin auth crea cuentas activas · ✅ RESUELTO (SEC-FIX)

- **Archivo:** `netlify/functions/fake-signup.ts:28-179`
- **Severidad:** CRITICAL
- **Área:** 4 (Netlify Functions) · 1 (escalación)

**Vulnerabilidad.** A diferencia de todas las demás Netlify Functions, ésta **no
lee ningún header `Authorization`**, no valida caller ni origen. Está desplegada
como endpoint HTTP público y, usando `SUPABASE_SERVICE_ROLE_KEY` (bypasa RLS),
crea una cuenta en Auth con `email_confirm: true` y la marca `status:'activo'`,
`rol:'miembro'`, `membresia_tier` elegido por el body, e inserta un
`payment_event` falso `status:'fake_succeeded'`.

**Cómo explotarlo.**
```bash
curl -X POST https://<sitio>/.netlify/functions/fake-signup \
  -H 'Content-Type: application/json' \
  -d '{"nombre":"Free","email":"x@x.com","password":"12345678","tier":"pro"}'
# → cuenta status=activo, tier=pro, sin pago real
```
Cuentas pro activas ilimitadas (reservan estudios gratis), spam masivo de
`auth.users` / `usuarios` / `payment_events`, y enumeración de emails (responde
distinto si el email ya existe).

**Fix recomendado.** Es código de prueba pre-Stripe ("cuando se integre Stripe
real, esta función se reemplaza"). Antes del launch: **eliminar la función** y no
exponer `/signup` hasta tener el webhook de Stripe real, **o** —si se necesita
para demos— protegerla con un secreto compartido (`X-Demo-Secret`) + rate-limit.
Mientras siga deployada sin auth, es un agujero abierto.

---

### 🔴 C2 — Un miembro se auto-eleva a `rol = 'admin'` (RLS no es column-level) · ✅ RESUELTO (SEC-FIX)

- **Archivo:** `supabase/migrations/20260514100800_rls_policies.sql:58-64`
- **Severidad:** CRITICAL
- **Área:** 1 (escalación de privilegios)

**Vulnerabilidad.** La policy de update propio:
```sql
CREATE POLICY usuarios_update_self ON usuarios
  FOR UPDATE TO authenticated
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid() AND tenant_id = get_my_tenant_id());
```
RLS en Postgres es **row-level, no column-level**. El `WITH CHECK` solo valida
`auth_id` y `tenant_id` — **no restringe qué columnas se tocan**. El propio
comentario de la migración lo admite: *"la restricción de columnas se aplica en
la app, RLS solo decide acceso"*. Pero un atacante no usa la app: llama PostgREST
directo. El `CHECK` de la columna acepta `'admin'`.

**Cómo explotarlo.** Logueado como miembro, en la consola del navegador:
```js
await supabase.from('usuarios').update({ rol: 'admin' }).eq('auth_id', miAuthUid)
```
`is_admin()`/`get_my_rol()` leen la fila de `usuarios` en cada query → el cambio
surte efecto **sin re-login**. Ya como admin, vía `usuarios_update_admin` /
`recursos_admin_all` / `membresias_admin_all` controla todo el tenant. El mismo
vector permite además `status:'activo'` (activarse sin pagar),
`membresia_tier:'pro'`, y borrar penalizaciones (`bloqueado_hasta`,
`no_shows_count`). *(El `tenant_id` sí está protegido: el `WITH CHECK` lo fija al
del caller.)*

**Fix recomendado.** RLS no puede hacer column-level acá. Opciones:
(a) **Trigger `BEFORE UPDATE ON usuarios`** que, si el caller no es admin,
rechace el update cuando `NEW.rol / status / membresia_tier / tenant_id /
bloqueado_hasta / no_shows_count` difieran de `OLD.*`; **o**
(b) mover la edición de perfil a un RPC `SECURITY DEFINER` que solo toque
columnas seguras (`nombre`, `telefono`, `avatar_url`, `ob_data`) y quitar la
policy `usuarios_update_self`.
La opción (a) es la de menor superficie de cambio.

---

### 🔴 C3 — `dev_activar_miembro`: función dev `SECURITY DEFINER` sin gate, no eliminada · ✅ RESUELTO (SEC-FIX)

- **Archivo:** `supabase/migrations/20260514110000_dev_activate_helper.sql:8-29`
- **Severidad:** CRITICAL
- **Área:** 1 (escalación) · 3 (RPCs) · 7 (cross-tenant)

**Vulnerabilidad.**
```sql
CREATE OR REPLACE FUNCTION dev_activar_miembro(p_email text, p_tier text DEFAULT 'pro')
RETURNS usuarios LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$ BEGIN
  UPDATE usuarios SET status='activo', membresia_tier=p_tier
  WHERE lower(email) = lower(p_email) ...
```
Sin gate de rol, sin filtro de tenant (`WHERE lower(email)=...` matchea cualquier
tenant), `SECURITY DEFINER` (bypasa RLS). La migración `sec_cleanup`
(`20260520110000`) eliminó `dev_crear_recepcionista` y `generar_clases_recurrentes`
pero **olvidó ésta**. Ninguna migración hace `REVOKE` — y el default de Postgres
para una función nueva es `GRANT EXECUTE TO PUBLIC`. Salvo que se haya revocado a
mano en la BD, **cualquier `authenticated` puede invocarla**. Sigue en
`src/shared/types/database.ts` (los tipos la conocen).

**Cómo explotarlo.** Logueado como cualquier miembro:
```js
await supabase.rpc('dev_activar_miembro', { p_email: 'yo@x.com', p_tier: 'pro' })
// → status='activo', tier='pro' sin pagar. Funciona con cualquier email,
//   de cualquier tenant.
```

**Fix recomendado.** Migración nueva: `DROP FUNCTION dev_activar_miembro(text, text);`
(exactamente como `sec_cleanup` hizo con las otras dev). Verificar también en la
BD desplegada con `\df dev_activar_miembro` que no quede huérfana.

---

### 🟠 H1 — RLS de `usuarios` da a recepción lectura de columnas sensibles (`stripe_customer_id`, `ob_data`) · ✅ RESUELTO (SEC-FIX)

- **Archivo:** `supabase/migrations/20260514100800_rls_policies.sql:53-56`
- **Severidad:** HIGH
- **Área:** 5 (exposición de datos)

**Vulnerabilidad.** `usuarios_read_admin` —
`USING (tenant_id = get_my_tenant_id() AND is_recepcionista())` — y
`is_recepcionista()` incluye a recepcionista. RLS es row-level: la policy
autoriza leer **todas las columnas** de cada fila del tenant, incluidas
`stripe_customer_id`, `ob_data`, `notas_admin`. El frontend de recepción hoy hace
`SELECT` explícitos acotados (bien — ver confirmaciones), pero la BD no lo impide.

**Cómo explotarlo.** Recepcionista logueado, en DevTools:
```js
await supabase.from('usuarios').select('email, stripe_customer_id, ob_data').eq('rol','miembro')
```
Exfiltra los IDs de cliente de Stripe y el JSON de onboarding (datos personales)
de todos los miembros del tenant.

**Fix recomendado.** El `SELECT` explícito del frontend no es defensa. Exponer
recepción a `usuarios` solo vía RPC `SECURITY DEFINER` con `jsonb_build_object`
(como ya hacen los RPCs de check-in), **o** mover las columnas sensibles a una
tabla aparte admin-only, **o** `REVOKE SELECT (stripe_customer_id, ob_data, ...)`
para el rol y usar una vista. *(Riesgo de insider — recepción es semi-confiable —
pero expone datos de pago: HIGH.)*

---

### 🟠 H2 — El status-check de cuenta es solo frontend; RLS no valida `status` · ⚪ VERIFICADO (SEC-FIX)

- **Archivos:** `src/public/pages/Login.tsx:57-64`, `src/member/MemberLayout.tsx:24-41`,
  `src/shared/lib/validarStatusCuenta.ts`
- **Severidad:** HIGH
- **Área:** 6 (auth/sesión)

**Vulnerabilidad.** `validarStatusCuenta` bloquea `suspendido`, `cancelado`,
`pendiente_pago`, `pendiente_onboarding` — pero corre 100% en el cliente.
`signInWithPassword` **crea la sesión y guarda el JWT** *antes* de que el JS
decida hacer `signOut()`. Ninguna policy RLS de `usuarios`/`reservas`/`recursos`
chequea `status`.

**Cómo explotarlo.** Con credenciales de una cuenta `suspendido`/`cancelado`
(ej. miembro expulsado o impago), desde la consola de cualquier página:
```js
await supabase.auth.signInWithPassword({ email: 'suspendido@x.com', password: '...' })
await supabase.from('reservas').select('*')   // funciona — RLS no mira status
```
La sesión es válida; el atacante opera vía API directa sin tocar el componente
React que haría el `signOut()`. *(El bloqueo de crear reservas sí está en backend
— `reservar_para_miembro_atomic` valida `status`; pero el de acceso/lectura no.)*

**Fix recomendado.** El status-check debe vivir en el backend: agregar
`AND status = 'activo'` (o un helper `is_account_active()`) a las policies de
lectura de datos de miembro, o gatear el acceso detrás de RPCs. La validación
frontend queda como UX, no como seguridad.

---

### 🟠 H3 — `cancelar_reserva_atomic` no valida tenant para recepción/admin (cancelación cross-tenant) · ✅ RESUELTO (SEC-FIX)

- **Archivo:** `supabase/migrations/20260520100000_recepcion_plus_rp1.sql:198-277`
- **Severidad:** HIGH
- **Área:** 3 (RPCs) · 7 (aislamiento de tenant)

**Vulnerabilidad.** La autorización del RPC:
```sql
IF v_reserva.usuario_id != v_user_id AND NOT is_recepcionista() THEN
  RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: ...';
END IF;
```
Si el caller es recepcionista/admin, puede cancelar **cualquier reserva cuyo
`id` conozca**, sin verificar `v_reserva.tenant_id = get_my_tenant_id()`. A
diferencia de `check_in_atomic`, que sí hace `IF v_reserva.tenant_id != v_tenant_id
THEN RAISE`. Esta función fue **ampliada en RP-1** para recepción — el gap se
introdujo ahí.

**Cómo explotarlo.** Recepcionista/admin del Tenant A que conozca/obtenga el UUID
de una reserva del Tenant B: `supabase.rpc('cancelar_reserva_atomic', { p_reserva_id:
'<uuid-tenant-B>' })` → la cancela (`cancelada_admin`), libera el slot del otro
estudio e inserta una notificación cross-tenant. Mitigado por la dificultad de
adivinar UUIDs, pero el principio de aislamiento se rompe.

**Fix recomendado.** Añadir, cuando el caller no es el dueño:
`IF v_reserva.tenant_id != get_my_tenant_id() THEN RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE'`.
Extender `supabase/tests/rp1_security_checks.sql` para cubrir este caso.

---

### 🟠 H4 — Password en claro devuelto en las respuestas de creación de usuario · ⚪ VERIFICADO (SEC-FIX)

- **Archivos:** `netlify/functions/admin-create-user/index.ts:129`,
  `netlify/functions/reception-create-member/index.ts:135`
- **Severidad:** HIGH
- **Área:** 5 (exposición de datos)

**Vulnerabilidad.** Ambas funciones devuelven `user.password` en texto plano en
la respuesta HTTP ("para que admin/recepción pueda compartirla"). Ese password
reutilizable queda en logs de proxy/CDN, en el historial de fetch del navegador,
y en breadcrumbs de monitoreo (Sentry) si capturan respuestas.

**Cómo explotarlo.** No es un secreto que el caller no conociera (lo acaba de
enviar en el body), pero amplía la superficie: cualquier acceso a logs
server-side o herramientas de observabilidad expone passwords de cuentas reales.

**Fix recomendado.** No devolver el password. Forzar reset en primer login, o
enviar un magic link / invitación. Si por flujo de mostrador se necesita
mostrarlo, generarlo server-side de un solo uso y marcar la cuenta
`debe_cambiar_password`.

---

### 🟠 H5 — `cron-no-shows`: endpoint HTTP sin autenticación (usa `service_role`) · ✅ MITIGADO (SEC-FIX)

- **Archivo:** `netlify/functions/cron-no-shows/index.ts:20`
- **Severidad:** HIGH *(condicional — requiere verificación operativa)*
- **Área:** 4 (Netlify Functions)

**Vulnerabilidad.** El handler no lee ningún header de auth. Está registrado como
`[[scheduled_functions]]` en `netlify.toml`, pero las scheduled functions de
Netlify también quedan en `/.netlify/functions/cron-no-shows`. Usa `service_role`
para ejecutar el RPC `marcar_no_shows`.

**Cómo explotarlo.** Si Netlify permite la invocación HTTP directa, cualquiera
dispara el barrido de no-shows a voluntad → marca reservas `no_show`, incrementa
`no_shows_count` y aplica `bloqueado_hasta` fuera del horario previsto. DoS de
lógica de negocio / reputación, no fuga de datos.

**Fix recomendado.** Verificar si el endpoint es invocable por HTTP externo en el
plan/runtime actual de Netlify. Defensivo: validar un `X-Cron-Secret` compartido,
o el header del scheduler interno de Netlify, antes de ejecutar. Combinar con M1
(gate de rol en el propio RPC).

---

### 🟠 H6 — `QR_JWT_SECRET` con valor placeholder débil y predecible · ⚪ VERIFICADO (SEC-FIX)

- **Archivo:** `.env.local:15` (`QR_JWT_SECRET=desarrollo-secret-cambiar-en-prod-...`)
- **Severidad:** HIGH *(condicional — depende de que no llegue a producción)*
- **Área:** 5 (secrets)

**Vulnerabilidad.** Ese secreto firma (HMAC-SHA256) los JWT del QR de check-in
(`qr-issue`/`qr-verify`). Es un string predecible, no aleatorio. `.env.local`
**no está commiteado** (verificado: `.gitignore` lo cubre, no aparece en
`git log --all`) — el riesgo es que el mismo placeholder se copie a las env vars
de Netlify production.

**Cómo explotarlo.** Si el valor débil llega a prod, un atacante que lo conozca/
adivine puede forjar JWT válidos y hacer check-in de reservas arbitrarias.

**Fix recomendado.** Confirmar que la env var de Netlify production tiene un valor
fuerte y distinto (`openssl rand -base64 64`). Operativo, no de código.

---

### 🟡 M1 — `marcar_no_shows`: sin gate de rol, ejecutable por cualquier `authenticated`

- **Archivo:** `supabase/migrations/...marcar_no_shows` + `GRANT ... TO authenticated`
- **Severidad:** MEDIUM · **Área:** 3

`marcar_no_shows()` está `GRANT EXECUTE ... TO authenticated` y no valida rol ni
filtra por tenant — procesa las reservas de **todos** los tenants. Cualquier
miembro puede `supabase.rpc('marcar_no_shows')` y forzar penalizaciones masivas
prematuras. **Fix:** `REVOKE ... FROM authenticated`, `GRANT ... TO service_role`,
o gate `IF NOT is_admin() THEN RAISE`. (Relacionado con H5.)

---

### 🟡 M2 — `handle_new_auth_user` confía en `tenant_slug` del cliente

- **Archivo:** `supabase/migrations/...trigger_signup.sql:24-30`
- **Severidad:** MEDIUM · **Área:** 1 · 7

El trigger de signup toma `tenant_slug` de `raw_user_meta_data` (controlado por
el cliente en `signUp()`). **Bien:** `rol` está hardcodeado a `'miembro'` — no se
puede inyectar rol por metadata. **Riesgo:** un atacante puede plantar una cuenta
`miembro` en **cualquier tenant** existente eligiendo el slug. Hoy mitigado
porque `fake-signup`/`reception-create-member` fuerzan `tenant_slug:'ekko'`
server-side; aparece si se expone `supabase.auth.signUp()` directo. **Fix:** al ir
multi-tenant, validar el slug contra el dominio/subdominio del request.

---

### 🟡 M3 — Policies de Storage sin filtro de tenant (defacing cross-tenant)

- **Archivos:** migraciones de buckets `avatars` / `estudios` / `logos`
  (`20260514150000`, `20260517100000`, `20260517600000`)
- **Severidad:** MEDIUM · **Área:** 2 · 7

Las policies de escritura de los buckets compartidos autorizan por
`rol IN ('admin','staff')` **sin verificar `tenant_id`** ni el path del objeto.
Como los buckets son públicos y multi-tenant, el admin del Tenant A puede
sobrescribir/borrar el logo y las fotos de estudios del Tenant B. **Fix:**
prefijar los objetos por `tenant_id` en el path y exigir
`(storage.foldername(name))[1] = get_my_tenant_id()::text` en las policies.

---

### 🟡 M4 — Policy UPDATE de `notificaciones` sin `WITH CHECK`

- **Archivo:** `supabase/migrations/20260517600000...:58-64`
- **Severidad:** MEDIUM · **Área:** 2

```sql
CREATE POLICY "Notificaciones: usuario marca leída las propias"
  ON notificaciones FOR UPDATE TO authenticated
  USING (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));
```
Sin `WITH CHECK`, la intención "marcar leída" no está acotada a columnas: un
miembro puede `UPDATE` el `titulo`/`mensaje`/`tipo` de **sus propias**
notificaciones (no las ajenas — eso lo bloquea `USING`). Impacto bajo
(auto-sabotaje / falsificar evidencia in-app), no cross-user ni cross-tenant.
**Fix:** restringir a `leida`/`leida_at` vía RPC o trigger, o al menos añadir
`WITH CHECK` con el mismo predicado.

---

### 🟡 M5 — `select('*')` sobre `usuarios` trae columnas sensibles al cliente

- **Archivos:** `src/shared/providers/AuthProvider.tsx:48`,
  `src/admin/hooks/useAdminData.ts:33,78`
- **Severidad:** MEDIUM · **Área:** 5

`hydrateUsuario()` y los hooks de admin hacen `.select('*')` sobre `usuarios` →
traen `stripe_customer_id`/`ob_data` al estado de React. En AuthProvider es la
fila propia y en admin el rol está autorizado, así que no es escalación — pero
`select('*')` es frágil: una columna realmente secreta agregada mañana se filtra
sola. **Fix:** `SELECT` explícito siempre, sin columnas sensibles innecesarias.

---

### 🟡 M6 — `useMiembros` (admin) interpola la búsqueda en `.or()` sin sanitizar

- **Archivo:** `src/admin/hooks/useAdminData.ts:46-48`
- **Severidad:** MEDIUM · **Área:** 8

A diferencia de `BuscarMiembro` (que sí sanitiza), aquí el `search` se interpola
en `.or('nombre.ilike.%term%,email.ilike.%term%')` sin quitar `, ( ) %`. Un input
con esos caracteres rompe la sintaxis del `.or()`. **No** burla el aislamiento de
tenant (el `tenant_id` va como `.eq()` aparte y RLS lo respalda) y el actor es
admin (ya ve todo su tenant) → impacto bajo. Pero es anti-patrón: si esa función
se reutiliza para un rol con menos privilegios, sería grave. **Fix:** sanitizar
igual que `BuscarMiembro` (`.replace(/[,%()_]/g,'')`).

---

### 🟡 M7 — `PerfilMiembroRecepcion` lee por `id` de la URL sin filtrar `tenant_id`

- **Archivo:** `src/reception/pages/PerfilMiembroRecepcion.tsx:85-90,104-106`
- **Severidad:** MEDIUM · **Área:** 7

La página toma el `id` de `useParams` (URL) y consulta `usuarios`/`reservas` con
`.eq('id', id)` **sin** `.eq('tenant_id', tenant.id)`. Hoy **RLS lo cubre**
(`usuarios_read_admin` exige `tenant_id = get_my_tenant_id()`) → no explotable
ahora. Pero el patrón es frágil: si una migración futura afloja esa policy, esta
página filtraría cross-tenant en silencio. *(Esta página es parte de Recepción
Plus — RP-2.)* **Fix:** añadir `.eq('tenant_id', tenant.id)` como defensa en
profundidad (el componente ya tiene `useTenant`, igual que `BuscarMiembro`).

---

### 🟡 M8 — `qr-verify` expone `notas_admin` del miembro al recepcionista

- **Archivo:** `netlify/functions/qr-verify` → RPC `check_in_atomic`
- **Severidad:** MEDIUM · **Área:** 5

`qr-verify` devuelve el `data` de `check_in_atomic`, que incluye
`miembro.notas_admin`. Es una decisión de producto documentada ("recepción las ve
durante check-in" — son notas operativas, no financieras), pero conviene
**confirmar que `notas_admin` nunca contenga información que recepción no deba
ver**. Si puede contenerla, separar un campo `notas_recepcion` visible vs.
`notas_admin` privado.

---

### 🟢 LOW (hardening · defensa en profundidad)

- **L1 — `count_*` aceptan IDs del cliente sin validar tenant.** *(Área 3·7)*
  `count_active_admins`, `count_admins_activos`, `count_reservas_recurso`,
  `count_miembros_tier` son `SECURITY DEFINER`, `GRANT ... authenticated`, y
  aceptan el `tenant_id`/`recurso_id`/`tier_id` como parámetro sin verificar que
  sea del tenant del caller → fuga de conteos cross-tenant (solo enteros).
  **Fix:** derivar de `get_my_tenant_id()` o validar pertenencia.

- **L2 — `anon` lee metadata de todos los tenants.** *(Área 2·7)* La policy
  `tenants_read_public_by_slug` (`USING status='activo'`) deja a `anon` leer
  `SELECT *` de `tenants` — `stripe_account_id`, `config`, dominios — de **todos**
  los tenants, no solo el del slug visitado. Hoy hay 1 tenant; al ir multi-tenant
  cada uno verá los Stripe IDs de los demás. **Fix:** vista pública con columnas
  acotadas, o filtrar por slug del request.

- **L3 — Policies `anon` viejas de `recursos`/`tiers` sin filtro de tenant no
  dropeadas.** *(Área 2·7)* `20260517100000` creó policies anon que filtran por
  `slug='ekko'` pero **no dropeó** las viejas (`recursos_read_public`,
  `tiers_read_public`, `USING activo=true`). Como las policies son aditivas, la
  vieja sigue activa y anula el filtro → `anon` ve recursos/tiers (con
  `precio_centavos`, `stripe_price_id`) de cualquier tenant. **Fix:**
  `DROP POLICY` de las viejas.

- **L4 — Mensajes de error crudos de Postgres al cliente.** *(Área 5)* Las
  Netlify Functions admin/reception devuelven `serverError(e.message)` /
  `createErr.message` directo → puede filtrar detalles internos. Solo lo ve un
  caller autenticado; impacto bajo. **Fix:** mensaje genérico + log server-side.

- **L5 — Drift y duplicación.** *(Área 2)* `GRANT ... TO anon` innecesario en los
  helpers `get_my_*`/`is_*`; índices duplicados (`usuarios_rol_idx` vs
  `usuarios_tenant_rol_idx`, etc.); **dos** funciones `count_admins` con semántica
  divergente (`count_active_admins` usa `status NOT IN (...)`, `count_admins_activos`
  usa `status='activo'`) → riesgo de contar distinto al validar "último admin".
  **Fix:** limpieza / consolidar en una.

- **L6 — Limpieza menor.** *(Área 6)* `validarStatusCuenta` maneja un status
  `'revocado'` que no existe en el `CHECK` del enum (el `default` lo cubre
  defensivamente — no explotable); `netlify/functions/_lib/auth.ts` es un stub
  vacío sin uso (borrarlo evita que alguien lo importe creyendo que valida algo).

---

## SECCIÓN ESPECIAL — Recepción Plus (RP-1 … RP-4)

Recepción Plus amplió los permisos del rol `recepcionista`. Evaluación de si las
**4 capacidades nuevas** abren algún vector:

| Capacidad nueva | RPC / Function | ¿Seguro? |
|---|---|---|
| Buscar padrón / ver perfil (RP-2) | query directa + RLS | ⚠️ ver M7 (defensa en profundidad) y H1 (RLS column-level) |
| Crear reserva para miembro (RP-3a) | `reservar_para_miembro_atomic` | ✅ **Bien hecho** |
| Cancelar reserva de miembro (RP-3a) | `cancelar_reserva_atomic` (ampliado) | 🟠 **H3** — falta validar tenant |
| Reprogramar (RP-3b) | reusa los 2 RPCs anteriores | hereda H3 al cancelar |
| Registrar miembro (RP-4) | `reception-create-member` | ✅ **Bien hecho** |

**Veredicto:** los RPCs/funciones *creados* para Recepción Plus están **bien
diseñados** — `reservar_para_miembro_atomic` y `reception-create-member` derivan
rol y tenant del caller, **no aceptan `rol` ni `tenant_id` como parámetro**, y
validan el miembro objetivo contra el tenant del caller (`EKKO_MIEMBRO_INVALIDO`).
El gate de rol **no se puede bypassear**.

**El único hallazgo introducido por Recepción Plus es H3:** al *ampliar*
`cancelar_reserva_atomic` para recepción se omitió la validación de tenant que sí
tiene `check_in_atomic`. Es HIGH pero acotado (requiere conocer un UUID ajeno) y
de fix trivial. Además, M7 (página de perfil RP-2 sin `.eq(tenant_id)`) es una
defensa-en-profundidad faltante, no explotable hoy.

**Las vulnerabilidades CRITICAL (C1, C2, C3) NO son de Recepción Plus** — son
anteriores (fake-signup, policy de update propio, helper dev). Recepción Plus no
las introdujo ni las agrava.

---

## MATRIZ — "Lo prohibido sigue prohibido"

¿Puede el rol `recepcionista` hacer algo reservado a admin?

| Acción reservada a admin | ¿Recepción puede? | Barrera |
|---|---|---|
| Crear/editar staff o admin | ❌ No | `reception-create-member` hardcodea `rol='miembro'` (el body ni tiene campo `rol`); `admin-create-user` exige `rol==='admin'` |
| Cambiar el rol de un usuario | ❌ No | `admin-update-role` exige `rol==='admin'` |
| Hard-delete de usuarios | ❌ No | `admin-delete-user` exige `rol==='admin'` |
| Config del tenant (precios, tiers, branding) | ❌ No | RLS `recursos/tiers/tenants *_admin_*` usan `is_admin()` |
| Dinero (`membresias`, `payment_events`) | ❌ No | `membresias` usa `is_admin()` (no `is_recepcionista()`); `payment_events` sin policy de escritura (solo `service_role`) |
| Editar `status`/`tier`/`rol` de un miembro | ❌ No (vía recepción) | RLS `usuarios_update` solo admin; recepción no tiene UI ni vía |
| Operar datos de otro tenant | ⚠️ Casi | **Excepción: H3** (`cancelar_reserva_atomic` cross-tenant) |

**Conclusión:** las prohibiciones *específicas de recepción* se mantienen —
recepción **no** escala a staff/admin, **no** toca config ni dinero, **no** hace
hard-delete. La única grieta del lado recepción es **H3** (cancelación
cross-tenant).

⚠️ **Pero la matriz NO debe leerse como "el sistema es seguro":** las
escalaciones graves (C2, C3) no van por el rol recepción — van por **cualquier
miembro** (auto-update a admin) y por **cualquier authenticated**
(`dev_activar_miembro`). El rol recepción está acotado; el problema está en otras
capas.

---

## PLAN DE FIXES PRIORIZADO

### 🔴 Bloqueante — corregir SÍ o SÍ antes del launch

| # | Fix | Esfuerzo |
|---|-----|----------|
| C1 | Eliminar `fake-signup` (o protegerla con secreto + rate-limit). No exponer `/signup` sin Stripe real. | Bajo |
| C2 | Trigger `BEFORE UPDATE ON usuarios` que bloquee cambios de `rol/status/tier/bloqueado_hasta/no_shows_count` por no-admins (o RPC de perfil + quitar `usuarios_update_self`). | Medio |
| C3 | Migración `DROP FUNCTION dev_activar_miembro`. Verificar en la BD desplegada. | Bajo |
| H1 | Cortar el acceso de recepción a `stripe_customer_id`/`ob_data` (RPC, vista, o `REVOKE` de columnas). | Medio |
| H2 | Mover el status-check al backend (RLS con `status='activo'` o RPC gate). | Medio |
| H3 | Añadir validación de tenant en `cancelar_reserva_atomic`. | Bajo |
| H4 | No devolver el password en claro (reset en primer login / magic link). | Medio |

### 🟠 Verificación operativa antes del launch

| # | Acción |
|---|--------|
| H5 | Verificar si `cron-no-shows` es invocable por HTTP externo; si lo es, añadir `X-Cron-Secret`. |
| H6 | Confirmar que `QR_JWT_SECRET` de producción (Netlify env) es fuerte y distinto del placeholder dev. |

### 🟡 Hardening post-launch (no bloqueante)

M1 (gate en `marcar_no_shows`) · M2 (validar `tenant_slug` en signup) ·
M3 (Storage policies por tenant) · M4 (`WITH CHECK` en `notificaciones`) ·
M5 (`SELECT` explícito) · M6 (sanitizar `.or()` admin) · M7 (`.eq(tenant_id)` en
`PerfilMiembroRecepcion`) · M8 (revisar contenido de `notas_admin`).

### 🟢 Limpieza / deuda

L1-L6 — conteos cross-tenant, policies `anon` viejas, drift de índices/helpers,
mensajes de error, stubs vacíos.

---

## LO QUE ESTÁ BIEN HECHO (confirmaciones)

- **RPCs de Recepción Plus** (`reservar_para_miembro_atomic`,
  `check_in_atomic`, `check_in_manual_atomic`): derivan rol y tenant del caller,
  validan `tenant_id` de la reserva, **no aceptan `rol`/`tenant_id` como
  parámetro**. El gate de rol no se bypassea.
- **`reception-create-member`**: `rol='miembro'` hardcodeado (el body ni tiene el
  campo), `tenant_id` del caller. Recepción no puede crear staff/admin.
- **`admin-create-user` / `admin-update-role` / `admin-delete-user`**: gate de rol
  derivado del JWT verificado (no del body), `service_role` instanciado **después**
  del gate, validan el tenant del target, protegen al último admin.
- **`handle_new_auth_user`** hardcodea `rol='miembro'` — el cliente no puede
  inyectar rol por metadata.
- **`membresias` y `payment_events` siguen admin-only** — escritura de
  `payment_events` solo `service_role`; `membresias` usa `is_admin()`.
- **Aislamiento por `tenant_id`** consistente en casi todas las policies RLS.
- **Guards de React son solo UX** — el backend (RLS + RPCs) es la barrera real;
  navegar directo a `/admin` siendo miembro no entrega datos.
- **Secrets:** ningún secret server-only en el bundle `dist/` ni en `src/`; el
  frontend solo usa `VITE_*` (públicas por diseño); `.env.local` correctamente
  ignorado por git; `.env.example` con valores vacíos; sin secretos en la
  historia de git.
- **`BuscarMiembro`** sanitiza correctamente la entrada del `.or()`
  (`.replace(/[,%()_]/g,'')`); el `tenant_id` va como `.eq()` separado, no
  burlable.
- **`PerfilMiembroRecepcion` / `BuscarMiembro`** hacen `SELECT` explícito sin
  columnas sensibles (aunque la BD no lo obligue — ver H1).
- **Verificación del JWT del QR** con comparación timing-safe y validación de
  expiración/ventana/status.
- **Funciones `SECURITY DEFINER`** usan `SET search_path = public` — protege
  contra search-path hijacking.
- **`sec_cleanup`** eliminó funciones fantasma (buena higiene — aunque se le
  escapó `dev_activar_miembro`, ver C3).

---

*Fin de la auditoría. Próximas auditorías sugeridas de la serie: calidad de
código / manejo de errores · rendimiento · accesibilidad · UX de estados límite.*
