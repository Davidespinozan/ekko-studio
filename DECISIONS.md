# DECISIONS — EKKO Studio

Índice de decisiones de producto/arquitectura durables. Históricamente vivían
**dispersas en comentarios** del código y migraciones (marcadas `D1`, `H3`,
`L-01`, `R6`, etc.); este archivo las junta para que sean rastreables. Cada
entrada apunta a dónde vive el detalle. El detalle largo de cada bloque está en
`KERNEL.md`.

> Convención: `EKKO-NNN` para decisiones nuevas a partir de acá. Las históricas
> conservan su marcador original (`D1`, `H3`...) para no romper los comentarios
> que las referencian.

---

## Plataforma / infra

- **D-006 — No `await supabase.from()` dentro de `onAuthStateChange`.** El
  cliente Supabase JS v2 hace deadlock si se consulta la DB dentro del callback
  de auth. Diferir con `setTimeout(() => {...}, 0)`. Ver `src/shared/lib/
  supabase.ts` y `src/shared/providers/AuthProvider.tsx`.
- **Tests sin `.env.local`** — `vitest.config.ts` inyecta `VITE_SUPABASE_*`
  placeholder para que los módulos que importan el cliente real no tiren
  `supabaseUrl is required` en CI. No toca runtime.
- **CI** — `lint + tsc + tests + build` en cada push/PR a main
  (`.github/workflows/ci.yml`). El job e2e queda dormido hasta `vars.RUN_E2E` +
  secrets de Supabase.

## Producto — Recepción (serie D)

- **D1 — Walk-ins:** recepción reserva sin validar `min_anticipacion_horas`
  (`reservar_para_miembro_atomic`). Recepción atiende en mostrador, no aplica la
  anticipación del flujo del miembro.
- **D2 — Solo miembros activos:** `reservar_para_miembro_atomic` exige
  `status='activo'` del target.
- **D3 — Cancelación por un tercero:** si cancela recepción/admin (≠ dueño), la
  reserva pasa a `cancelada_admin` + `cancelada_por` + notificación al miembro
  "por el estudio" (`cancelar_reserva_atomic`).
- **D5 — Contrato acotado de alta:** `reception-create-member` fija
  `rol='miembro'` hardcodeado (recepción nunca crea staff) y `tenant` del caller;
  distinto de `admin-create-user`.
- **D6 — Reprogramar no es atómico:** = cancelar la vieja + crear la nueva (dos
  RPCs), con manejo explícito de fallos parciales (`reprogramarReserva.ts`).
- **R3 — Perfil de recepción NO reusa `MiembroDetalle` de admin:** se hizo una
  vista propia para no arrastrar acciones peligrosas (borrar/rol). *(El
  comentario "READ-ONLY" quedó obsoleto: hoy es un hub de gestión.)*
- **R6 — Sin campos sensibles en el SELECT:** el perfil de recepción no pide
  `stripe_customer_id` ni `ob_data`.

## Seguridad (SEC-FIX — serie C/H)

- **C2 — Trigger de columnas privilegiadas:** `usuarios` no deja a un
  `authenticated` tocar `rol/tenant/status/tier/no_shows_count/bloqueado_hasta`
  vía PostgREST. Recepción lo rodea **por diseño** vía Netlify Functions con
  `service_role`. **C2a:** `rol` es intocable salvo `admin-update-role`.
- **H1 — Columnas sensibles aparte:** `stripe_customer_id` y `ob_data` viven en
  `usuarios_datos_privados` (RLS admin-only). Recepción no las alcanza.
- **H3 — Cancelación cross-tenant:** `cancelar_reserva_atomic` valida que un
  tercero solo cancele reservas de su tenant. Replicado en todas las Netlify
  Functions de recepción (`target.tenant_id === caller.tenant_id`).
- **H4 — Passwords nunca al log:** el alta/reset devuelven el password para
  entregar en mostrador, pero no se loguea.
- **H5 — `marcar_no_shows` solo `service_role`:** era ejecutable por cualquier
  `authenticated` (penalizaciones masivas). Revocado.
- **H6 — `QR_JWT_SECRET`** es env var de Netlify (operativo).
- **C1 — Endpoint público sin pago no inserta `payment_event`.**

## Gobernanza / auditoría (Bloque A)

- **`audit_log` insert-only** (sin policies de UPDATE/DELETE), escrito solo por
  `service_role`. SELECT admin = todo el tenant; recepción = `target_tipo='usuario'`.
- **Razón obligatoria** en acciones sensibles (status/tier/desbloqueo/no-show/
  corrección de check-in).
- **B1/B2 — La auditoría salió de `notas_admin`** (campo borrable por admin) al
  `audit_log` inmutable; `notas_admin` vuelve a ser solo notas humanas.
- **B4 — Desbloqueo NO resetea `no_shows_count`** (antes lo ponía en 0 en
  silencio); solo limpia `bloqueado_hasta`.

## Lógica (LOGIC-FIX — serie L)

- **L-01 — Timezone `America/Mazatlan`:** la validación de horario del estudio se
  ancla a la hora de Culiacán, no a la timezone de la sesión Postgres.
- **L-02 — Check-in rechaza todo estado no `confirmada`** (incluido
  `cancelada_admin`).
- **L-03 — `revocado`** agregado al `CHECK` de `usuarios.status`.

## Error-UI (ERROR-UI-FIX — serie E)

- **E-01..E-06 — Nunca exponer el error crudo del servidor al usuario** +
  distinguir "sin datos" de "falló la carga" (estados `isLoading`/`error`
  reales). Traductores `traducirErrorRPC`/`traducirErrorReserva`/
  `traducirErrorRegistro`; `backendPost` propaga el mensaje del servidor.

## Bloques del rediseño de recepción

`A` gobernanza · `B+C` agenda + panel Hoy + nueva IA · `D` no-show manual +
corregir check-in · `E` notas + aviso · `F` recurso fuera de servicio. Detalle
completo en `KERNEL.md`.

---

## Decisiones PENDIENTES (necesitan input del dueño)

- **D4 — Modelo de cobro (SIN decidir).** Bloquea pagos/Stripe. Define:
  suscripción mensual por tier vs pago único; trial sí/no; self-serve vs cobro
  en mostrador. Hoy: signup simulado, "cambiar plan" por WhatsApp.
- **B3 — Cambiar tier no activa la cuenta** (queda inconsistente). Se resolverá
  al cablear la activación en un solo RPC (ver `BACKLOG.md` → Pagos).
