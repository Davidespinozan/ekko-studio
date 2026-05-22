# Auditoría de Manejo de Errores y Estados de UI — EKKO Studio

**Fecha:** 2026-05-22
**Tipo:** Auditoría READ-ONLY (ningún archivo de código modificado)
**Alcance:** 9 áreas — loading, empty, error, fallos de red, consistencia,
formularios, auth/sesión, fallos parciales, feedback de éxito + render.
**Método:** 3 agentes paralelos (Member+Public · Admin+Reception ·
cross-cutting) + **verificación manual de todo HIGH** contra el código real.
Varios findings de los agentes estaban sobre-calificados y se recalibraron
(lección C2b — la severidad sigue la evidencia, no la primera impresión).
**Estado del repo:** `main`, commit `6dcb77e`.

---

## ⚠️ RESUMEN EJECUTIVO

La **infraestructura de errores está bien diseñada**: hay un `ErrorBoundary`
global (`main.tsx:24`) — un crash de render NO tumba la app a pantalla blanca,
cae a un fallback con "Recargar". **No hay un solo `alert()`** en toda la app.
El sistema de toast es consistente, `fetchWithTimeout` traduce el timeout a copy
humano, y recepción usa sus traductores de error (`traducirErrorReserva`/
`traducirErrorRegistro`) con disciplina.

El problema no es la infraestructura — es **consistencia**: el patrón seguro
existe pero no es universal. Tres clases de defecto se repiten:

1. **Errores crudos de Supabase/Postgres/HTTP que llegan al usuario** — los
   traductores de member (`traducirErrorRPC`, `traducirErrorQR`) terminan en
   `return message` (pasan el crudo); admin no usa ningún traductor; `backendPost`
   descarta el body del error y muestra `"backendPost path: 500"`.
2. **Errores de carga tragados → falsos empty states** — varios hooks, al fallar
   la query, devuelven datos vacíos sin marcar error → la pantalla muestra "no
   hay nada" cuando en realidad la carga falló.
3. **Imágenes sin `onError`** — ninguna `<img>` tiene fallback si la URL muere.

| Severidad | Cantidad |
|-----------|----------|
| 🔴 HIGH | 3 |
| 🟡 MEDIUM | 13 |
| 🟢 LOW | 9 |
| **TOTAL** | **25** |

### 🔴 Los 3 HIGH

**E-01 · `TenantProvider` muestra el error crudo de Postgres en la pantalla de
arranque pública.** Si falla la carga del tenant, la pantalla full-screen "No se
pudo cargar la configuración" renderiza `queryError.message` — texto técnico de
Supabase/Postgres — y es lo **primero que ve cualquier visitante** ante un fallo
de backend.

**E-02 · El Dashboard del miembro miente sobre sus reservas.** `useProximasReservas`
descarta el `error` de la query y no expone `isLoading`. Mientras carga —y para
siempre si la query falla— el miembro ve **"SIN SESIONES AGENDADAS"** aunque
tenga reservas confirmadas. Sin error, sin retry. El miembro cree que perdió su
reserva.

**E-03 · El Dashboard del admin muestra ceros silenciosos.** `useDashboardData`
hace `Promise.all` de 9 queries y **no chequea el `error` de ninguna**. Si
fallan (red/RLS), el dashboard renderiza "0 reservas hoy", métricas en 0,
gráfica vacía — **indistinguible de un negocio sin actividad**. El admin no tiene
forma de saber que la carga falló.

> **Calibración honesta:** ninguno de los 3 es "pantalla blanca/rota" en sentido
> literal (el `ErrorBoundary` cubre los crashes de render). Son HIGH **por
> impacto**: E-01 expone datos técnicos en la cara pública del producto; E-02 y
> E-03 hacen que la pantalla principal *afirme algo falso* en un flujo central,
> sin auto-corregirse ni dar salida. El resto de "errores crudos" quedó en
> MEDIUM: son feos pero el que los ve suele ser un admin de confianza y no queda
> atascado.

---

## 🔴 FINDINGS HIGH

### E-01 — `TenantProvider`: error crudo de Postgres en la pantalla de arranque

- **Archivo:** `src/shared/providers/TenantProvider.tsx:75` (arma el mensaje) y `:146` (lo renderiza)
- **Severidad:** HIGH · **Área:** 3 (error crudo expuesto)

**Qué pasa.** Ante un `queryError` de Supabase al cargar `tenants`, hace
`setError(new Error(`No se pudo cargar el tenant: ${queryError.message}`))`, y la
pantalla de error full-screen renderiza `{error?.message}`. El `queryError.message`
crudo de PostgREST/Postgres se concatena y se muestra. Este provider es la raíz
de todo public + member (`main.tsx:25`).

**Cuándo se manifiesta.** Caída de Supabase, RLS mal configurada, o problema de
red en el primer load → cualquier visitante de la landing ve "No se pudo cargar
la configuración" con texto técnico debajo (`relation "tenants" does not exist`,
`JWT expired`, detalles de schema).

**Confirmado.** Leí `TenantProvider.tsx:74-82` (`new Error(...${queryError.message})`)
y `:146` (`{error?.message ?? 'Tenant no disponible'}` en el JSX).

**Fix recomendado.** En la rama `queryError` usar copy fijo ("No pudimos cargar
la configuración del estudio. Verificá tu conexión e intentá de nuevo.") + botón
Recargar. El detalle técnico va a `console.error`/Sentry, no a la UI. *(La rama
"tenant no encontrado", `:81`, ya es human-friendly — solo la rama `queryError`
filtra crudo.)*

### E-02 — Dashboard del miembro: empty state falso, sin loading ni error

- **Archivo:** `src/member/pages/Dashboard.tsx:53-83` (`useProximasReservas`), render `:154`
- **Severidad:** HIGH · **Área:** 1 (loading), 3 (error tragado), 4 (red)

**Qué pasa.** `useProximasReservas` hace `const { data } = await supabase…` —
**descarta `error`**. Retorna solo `{ reservas, refetch }`: no hay `isLoading`
ni `error`. `reservas` arranca en `[]`, así que en el primer render
`proximaReserva` es `undefined` y el Dashboard pinta el empty state "SIN
SESIONES AGENDADAS". Si la query falla, ese empty falso queda **permanente**.

**Cuándo se manifiesta.** Miembro con reservas + conexión lenta → flash de "no
tenés reservas". Red caída → "no tenés reservas" para siempre, sin aviso ni
retry. El miembro cree que su reserva desapareció.

**Confirmado.** Leí el hook completo (`:53-83`): `const { data } = await…`
(`error` descartado), retorna `{ reservas, refetch }` sin `isLoading`/`error`. El
render (`:154`) es `proximaReserva ? hero : empty` — sin tercer estado.

**Fix recomendado.** Agregar `isLoading` y `error` al hook; mientras carga,
skeleton del card hero; si hay error, card con "Reintentar" (`refetch`). No
mostrar el empty state hasta confirmar query OK con `[]`.

### E-03 — Dashboard del admin: `useDashboardData` traga todos los errores

- **Archivo:** `src/admin/hooks/useAdminData.ts:337-462` (`useDashboardData`)
- **Severidad:** HIGH · **Área:** 3 (error tragado), 4 (red)

**Qué pasa.** El `Promise.all` de 9 queries — los resultados se consumen solo por
`.data`/`.count` (`reservasMesActual.count ?? 0`, etc.); **el `.error` de cada
uno se ignora**. `setData(...)` se llama igual con todo en cero/vacío y
`setIsLoading(false)`. El `AdminDashboard` renderiza un dashboard "válido" en
cero. Los otros hooks del mismo archivo (`useMiembros`, `useRecursosAdmin`,
`useTiersAdmin`) **sí** hacen `if (error) { console.error; return; }` —
`useDashboardData` es el único sin ningún chequeo.

**Cuándo se manifiesta.** Fallo de red/RLS al cargar el dashboard (la pantalla de
aterrizaje del admin) → "0 reservas hoy", métricas 0, gráfica vacía. El admin no
distingue "negocio sin actividad" de "la carga falló".

**Confirmado.** Leí `useDashboardData` (`:342-462`): el array desestructurado usa
solo `.data`/`.count`, nunca `.error`; `setData` incondicional.

**Fix recomendado.** Revisar `.error` de cada resultado; si hay fallo, exponer
estado `error` y que `AdminDashboard` muestre "No se pudo cargar el dashboard ·
Reintentar" en vez del dashboard-en-cero.

---

## 🟡 FINDINGS MEDIUM

### Errores crudos / técnicos mostrados al usuario (Área 3 · 5)

**E-04 — `traducirErrorRPC` pasa el mensaje crudo en su fallback.**
`src/member/logic/reservaLogic.ts:241` termina en `return message`. No tiene
caso para `EKKO_NO_AUTH` ni `EKKO_FUERA_DE_HORARIO` (los RPCs los emiten), ni
para errores no-`EKKO_*` (red, deadlock, RLS) → todos se muestran crudos. El
miembro al reservar/cancelar puede ver `EKKO_NO_AUTH: Usuario no autenticado` o
texto de Postgres. *(Confirmado leyendo la función completa — contraste:
`traducirErrorReserva` de recepción sí tiene fallback genérico.)* **Fix:**
cambiar `return message` por un genérico ("No se pudo completar la reserva.
Intentá de nuevo.") + agregar los códigos faltantes.

**E-05 — `traducirErrorQR` pasa el crudo + `backendPost` HTTP técnico.**
`MiQR.tsx:36` termina en `return raw`. El `error` se setea con `e.message`, que
para fallos de `backendPost` es `"backendPost qr-issue: 500"`. `traducirErrorQR`
no matchea eso → el miembro ve `backendPost qr-issue: 500` donde iría el QR.
**Fix:** fallback genérico en `traducirErrorQR`; detectar 5xx/timeout.

**E-06 — `backendPost`/`backendGet` descartan el body del error del servidor.**
`src/shared/lib/backend.ts:30`: `throw new Error(`backendPost ${path}: ${res.status}`)`
— nunca lee el `{error: "..."}` que la Netlify Function devuelve. `NuevaPersonaModal`
muestra `setError(err.message)` → el admin ve **"backendPost admin-create-user:
409"** en vez de "Ya existe una cuenta con ese email". `Scanner` muestra
`"backendPost qr-verify: 500"`. *(Confirmado: `CrearAccesoModal` y
`RegistrarMiembroModal` usan `fetch` crudo a propósito, con comentario explícito,
**para esquivar este bug** — la solución correcta ya existe en el repo, solo no
está en `backendPost`.)* **Fix:** en `backendPost`/`backendGet`, leer el body en
el path de error y lanzar `Error(body.error ?? 'HTTP NNN')`.

**E-07 — Mutaciones de admin muestran el error crudo de Supabase.**
`useAdminData.ts` (`updateMiembro:105`, `updateRecurso`, `insertRecurso`,
`updateTier`, `insertTier`) y `crudHelpers.ts` (`archiveRecord`/`restoreRecord`)
devuelven `error: error?.message` — el mensaje crudo de PostgREST. Los callers
(`MiembroDetalle.tsx:42`, `Tiers.tsx`, `Recursos.tsx`, `Ajustes*`) lo muestran
directo en `<p className="ek-error-text">{error}</p>` o `toast.error`. Ante un
fallo de RLS o constraint el admin ve `duplicate key value violates unique
constraint "tiers_slug_key"` o `new row violates row-level security policy`.
**Admin no usa ningún traductor de errores.** **Fix:** un `traducirErrorSupabase`
compartido (constraint → "Ya existe…", RLS → "Sin permiso…", red → genérico) o
al menos un fallback genérico; el crudo a Sentry.

**E-08 — Signup muestra el `result.error` crudo del backend.**
`Signup.tsx:180,196` — si `fake-signup` devuelve un error que no matchea
"already/registered/exists", hace `throw new Error(result.error)` y lo pinta en
el banner. `traducirErrorRegistro` existe y no se reutiliza acá. **Fix:** pasar
`result.error` por un traductor.

### Errores de carga tragados → falsos empty states (Área 2 · 3 · 4)

**E-09 — Calendario admin y "reservas de hoy" de recepción: error → falso
"no hay reservas".** `useReservasRango` (`useAdminData.ts:492-498`) y
`useReservasHoy` (`useReservasHoy.ts:51-55`) ante error hacen `console.error` +
`setIsLoading(false)` sin marcar error ni limpiar nada. `VistaDia`/`VistaSemana`
/`ReservasHoyView` con `isLoading=false` + `reservas=[]` muestran "No hay
reservas para este día". El admin/recepción cree que el día está vacío cuando la
query falló. **Fix:** exponer `error`; distinguir vacío real de error + retry.

**E-10 — Perfil del miembro: historial y stat del mes sin loading/error.**
`Perfil.tsx` — `useReservasPasadas` y `useStatsDelMes` descartan el `error` y no
exponen `isLoading`. Mientras carga muestra "Aún no tienes sesiones completadas"
(empty falso); si falla, queda permanente; la stat del mes muestra `0`. **Fix:**
exponer `isLoading`/`error`, skeleton + retry.

**E-11 — Hooks de lectura tragan el error solo a `console.error`.**
`useRecursosDelTenant` (`useReservas.ts:124`), `fetchReservasDelRecurso/Usuario`
(`:157,182`), `useRecursosAdmin`/`useTiersAdmin` (`useAdminData.ts:124,184`),
`useTenantConfigEditor` (`:29`) — al fallar la query loguean a consola y
devuelven datos vacíos. La UI no distingue "no hay datos" de "falló la carga":
el miembro ve "No hay estudios disponibles" aunque el backend esté caído.
Prioridad: `useRecursosDelTenant` (bloquea reservar). **Fix:** exponer `error`;
las páginas distinguen empty de error.

### Fallos parciales y de red (Área 4 · 8)

**E-12 — Los fallos parciales de reprogramar se comunican solo por un toast de
5 s.** `reprogramarReserva.ts` devuelve `parcial_sin_recrear` ("el miembro quedó
SIN reserva" — el peor caso) y `parcial_sin_cancelar`. `CrearReservaModal.tsx:204-210`
los trata igual que cualquier error: `toast.error(mensaje)` + `onClose()`. El
toast `error` dura 5 s y desaparece; el modal se cierra. Si recepción miró para
otro lado, **pierde la instrucción de un fallo que dejó a un cliente sin
reserva**. El mensaje de texto es correcto y accionable — el canal (toast
efímero) no está a la altura. **Fix:** para `parcial_*`, un diálogo bloqueante
persistente (no auto-cierra) o un banner fijo en el perfil.

**E-13 — `Promise.all` de carga de slots sin `.catch()` → skeleton infinito.**
`Reservar.tsx:95-111` y `CrearReservaModal.tsx:138-157`: el `.then()` que hace
`setLoadingSlots(false)` no tiene `.catch`. Si la promesa se rechaza (rejection
de red inesperada), `loadingSlots` queda `true` para siempre → la grilla de
horarios muestra skeletons infinitos, sin error ni salida. **Fix:** `.catch` que
haga `setLoadingSlots(false)` + mensaje.

**E-14 — Si falla la carga de reservas, los slots se muestran todos
disponibles.** `fetchReservasDelRecurso/Usuario` ante error devuelven `[]` →
`generarSlotsDisponibles` calcula todo como libre. El miembro/recepción ve
horarios disponibles que están ocupados. El RPC atómico lo rechaza server-side
(`EKKO_SLOT_OCUPADO`, traducido bien) — la UX engaña hasta el submit. **Fix:**
distinguir "[] real" de "error de carga"; avisar "no pudimos verificar
disponibilidad".

**E-15 — `cancelarReserva`: el insert de notificación no se chequea.**
`crudHelpers.ts:320-338` — con `notificarMiembro=true`, el `insert` en
`notificaciones` y el `update` de `cancelacion_notificada_at` no revisan `error`.
La función retorna `{error:null}` si el cancel principal funcionó; `CancelarReservaModal`
hace `toast.success('Reserva cancelada.')`. El admin marcó "notificar" pero el
miembro puede no haberse enterado — fallo parcial silencioso. **Fix:** capturar
el error del insert; resultado parcial → "Reserva cancelada, pero no se pudo
notificar — avisale manualmente."

### Auth / formularios (Área 6 · 7)

**E-16 — `AuthProvider`: si falla la hidratación del usuario, los layouts quedan
en `LoadingScreen` infinito.** `hydrateUsuario` (`AuthProvider.tsx:52-57`) ante
error hace `console.error` + `return` sin setear `usuario` (queda `null`). Con
`authUser` válido + `usuario` null, `ReceptionLayout.tsx:28` (`if (!usuario)
return <LoadingScreen/>`) y `useAdminGuard` quedan en LoadingScreen **sin
salida**. Roza HIGH (es "atascado sin salida"), pero el disparador —fallo de la
query de hidratación con sesión válida— es poco frecuente. **Fix:** `hydrateUsuario`
debe exponer su error; los layouts → "No se pudo cargar tu perfil · Reintentar /
Cerrar sesión".

**E-17 — Signup: validación en un solo banner al pie, sin error por campo.**
`Signup.tsx:122-149,379` — toda validación (nombre, email, password, tarjeta,
exp, cvv) escribe en un único `error` mostrado en un banner **al final** del
form de 8 campos. En móvil con el teclado abierto el usuario no ve el banner ni
sabe qué campo está mal. **Fix:** error inline por campo, o `scrollIntoView` al
primer inválido.

### Render / imágenes (Área 9)

**E-18 — Ninguna `<img>` tiene `onError` — imágenes rotas se ven quebradas.**
11 `<img>` (avatares en `Perfil`, `MiembroDetalle`, `CheckInDetail`; `foto_url`
de estudios en `Estudios`, `EstudioDetalle`, `Recursos`, `EstudioModal`,
`Landing`; logo del tenant en `Sidebar`, `Footer`) — el patrón maneja
**URL ausente (null)** con un fallback de iniciales/placeholder, pero **no
URL presente pero rota** (404, objeto borrado del bucket, Storage caído) → ícono
de imagen rota del navegador. **Fix:** `onError` que oculte la `<img>` y revele
el fallback; idealmente un `<Avatar>` compartido.

---

## 🟢 FINDINGS LOW

- **E-19 — `LoadingScreen` es solo el texto "Cargando…"**, sin spinner ni logo
  (`LoadingScreen.tsx`). En cada navegación lazy aparece desnudo — parece
  pantalla rota. **Fix:** spinner/logo.
- **E-20 — Empty states ambiguos.** `Miembros.tsx:67` "Sin resultados" cubre
  "estudio nuevo" y "filtro sin coincidencias" sin distinguir ni CTA;
  `Reservar.tsx:283` "El estudio no opera este día" se muestra también cuando
  `slots=[]` por error. **Fix:** distinguir; mensajes neutros.
- **E-21 — Signup: falta guard `if (isProcessing) return`** al inicio de
  `handleSubmit` (`Signup.tsx:115`). Ventana de doble-submit chica (validaciones
  síncronas) pero el guard explícito falta. **Fix:** agregar el guard.
- **E-22 — `NuevaPersonaModal`/`CredencialesCreadasModal`: el click en backdrop
  cierra la vista de credenciales** (`NuevaPersonaModal.tsx:65`) — la password no
  se vuelve a ver. `RegistrarMiembroModal` sí lo bloquea a propósito. **Fix:** no
  cerrar por backdrop en la fase de credenciales.
- **E-23 — `MiembroDetalle` usa `window.confirm()` nativo** para el reset de
  password (`:469`) — el resto de admin usa `ConfirmDialog`. **Fix:** migrar.
- **E-24 — `CheckInDetail` renderiza `null` si el `success` viene con datos
  incompletos** (`:85`) → backdrop oscuro vacío 15 s hasta el auto-close. **Fix:**
  estado de error legible con botón cerrar.
- **E-25 — Doble feedback del mismo error** en `CrearAccesoModal.tsx:95-96`
  (`setError` + `toast.error` con el mismo texto). **Fix:** elegir uno (inline,
  como el resto de modales).
- **`fetchWithTimeout` re-lanza `Failed to fetch` crudo** en errores de red
  (`:28`) — solo traduce el timeout, aunque el JSDoc promete traducir también el
  network error. **Fix:** envolver el `TypeError` en copy de "sin conexión".
- **Landing: fallos de `useEstudiosPublicos`/`useTiersPublicos` solo van a
  `console.error`** — la landing pública renderiza secciones vacías sin aviso.
  **Fix:** mensaje de retry si quedan vacías por error.

---

## A CONFIRMAR (dudoso — no afirmado como bug)

- **Slots calculados sobre datos parciales (E-14) — ¿aceptable?** El RPC atómico
  es la fuente de verdad y rechaza el slot ocupado con mensaje traducido. Mostrar
  slots "disponibles" de más es UX degradada, no corrupción. Queda a decisión de
  producto si amerita el aviso "no pudimos verificar disponibilidad".
- **`AuthProvider` — ventana de carga.** El caso feliz (`authUser` llega antes
  que `usuario`) parece bien manejado por los guards. Solo el caso de error de
  hidratación es problema (E-16). No marco el caso feliz como bug.
- **`Scanner` con `qr-verify` → `{success:false, message}`.** Usa `res.message`
  asumiendo que el backend devuelve copy en español apto para usuario. No se
  leyó el handler de la Netlify Function en este scope — si devolviera un `EKKO_*`
  crudo ahí, sería un finding. A confirmar revisando `netlify/functions/qr-verify`.
- **`reprogramarReserva` — ¿el `mensaje` siempre es human-friendly?** Se mostró
  que devuelve `{estado, mensaje}` y el `mensaje` se pinta directo. El embebido
  de errores de RPC pasa por `traducirErrorReserva` (fallback seguro), así que
  probablemente OK — no se verificó cada rama.

---

## MATRIZ — loading / empty / error por pantalla

Leyenda: ✅ presente · ⚠️ parcial/defectuoso · ❌ ausente · N/A no aplica

### MEMBER
| Pantalla | Loading | Empty | Error |
|---|---|---|---|
| Dashboard — próxima reserva | ❌ E-02 | ⚠️ falso E-02 | ❌ E-02 |
| Dashboard — estudios | ⚠️ `isLoading` ignorado | ❌ | ⚠️ solo toast |
| Reservar — recursos/slots | ✅ skeleton | ⚠️ ambiguo E-20 | ❌ E-13 |
| Reservar — confirmar | ✅ disabled+loading | N/A | ⚠️ crudo posible E-04 |
| MiQR | ✅ skeleton | ✅ | ✅ con retry · ⚠️ crudo E-05 |
| Perfil — historial / stat | ❌ E-10 | ⚠️ falso E-10 | ❌ E-10 |
| Estudios / EstudioDetalle | ✅ skeleton | ⚠️ "no existe" en error E-11 | ⚠️ solo toast |

### PUBLIC
| Pantalla | Loading | Empty | Error |
|---|---|---|---|
| Landing — estudios/tiers | ✅ skeleton | ❌ | ❌ solo `console.error` |
| Login | ✅ disabled+loading | N/A | ✅ inline traducido |
| Signup | ✅ disabled+loading | ✅ | ⚠️ banner al pie E-17 · crudo E-08 |
| Arranque (TenantProvider) | ✅ LoadingScreen | N/A | ❌ crudo E-01 |

### ADMIN
| Pantalla | Loading | Empty | Error |
|---|---|---|---|
| Dashboard | ✅ skeleton | ✅ | ❌ ceros silenciosos E-03 |
| Miembros | ⚠️ texto plano | ⚠️ ambiguo E-20 | ⚠️ `useMiembros` traga |
| MiembroDetalle | ✅ | ✅ | ⚠️ crudo Supabase E-07 |
| Recursos / Tiers | ✅ | ✅ con CTA | ⚠️ crudo en modal E-07 |
| Equipo | ✅ | ✅ con CTA | ✅ toast |
| Calendario (Día/Semana) | ✅ | ✅ | ❌ falso empty E-09 |
| Ajustes (Landing/Contacto/Reglas) | ✅ skeleton | N/A | ✅ toast + validación |

### RECEPTION
| Pantalla | Loading | Empty | Error |
|---|---|---|---|
| Scanner / ReservasHoyView | ✅ skeleton | ✅ | ⚠️ falso empty E-09 · QR crudo E-06 |
| BuscarMiembro | ✅ skeleton | ✅ distingue + CTA | ⚠️ búsqueda traga error |
| PerfilMiembroRecepcion | ✅ skeleton | ✅ | ⚠️ "no encontrado" en error |
| CrearReservaModal | ✅ skeleton | ✅ | ⚠️ skeleton infinito E-13 · slots falsos E-14 |
| Cancelar / Registrar (modales) | ✅ | N/A | ✅ traducido |

---

## PLAN DE FIXES PRIORIZADO

### 🔴 Bloqueante pre-launch
- **E-01** — `TenantProvider`: copy fijo en la pantalla de arranque (no crudo).
- **E-02** — Dashboard del miembro: `isLoading`/`error` + skeleton + retry.
- **E-03** — Dashboard del admin: chequear el `.error` de las 9 queries.

### 🟡 Recomendado pre-launch (alto impacto, fix acotado)
- **E-06** — arreglar `backendPost`/`backendGet` para propagar el body del error
  (raíz de E-05/E-08; cierra varios crudos de una).
- **E-04 / E-05** — fallback genérico en `traducirErrorRPC` y `traducirErrorQR`.
- **E-07** — `traducirErrorSupabase` para las mutaciones de admin.
- **E-09 / E-10 / E-11** — exponer `error` en los hooks de lectura; distinguir
  empty real de error de carga.
- **E-12** — fallos parciales de reprogramar: diálogo persistente, no toast.

### 🟢 Post-launch / hardening
- E-13, E-14, E-15, E-16, E-17, E-18 y todos los LOW (E-19…E-25).

---

## LO QUE ESTÁ BIEN (verificado)

- **`ErrorBoundary` global** (`main.tsx:24`) — un crash de render no tumba la app
  a pantalla blanca; cae a un fallback con "Recargar" + reporte a Sentry.
- **Cero `alert()`** en toda la app — feedback por toast/inline, nunca el modal
  nativo del navegador.
- **Sistema de toast consistente** (`ToastProvider`, 4 variantes, `aria-live`).
- **`fetchWithTimeout`** traduce el timeout a copy humano.
- **Recepción** usa `traducirErrorReserva`/`traducirErrorRegistro` con disciplina
  en TODOS sus flujos de mutación — es el modelo a replicar en member y admin.
- **`ConfirmDialog`** reusado para acciones destructivas en admin.
- **Login** maneja errores de forma ejemplar — inline, traducido, con
  `traducirErrorAuth` (fallback seguro).
- **`errorMessages.ts`** (`src/shared/utils/`) está vacío (`export {}` con TODO):
  era el lugar previsto para centralizar la traducción y nunca se llenó — cada
  módulo hizo el suyo. Centralizarlo ahí cerraría E-04…E-08 de raíz.

---

*Fin de la auditoría de errores y UI. Cierra la serie de 3 auditorías de calidad
pre-launch (seguridad · lógica · errores/UI).*
