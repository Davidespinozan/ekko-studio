# E2E — runbook

Pruebas end-to-end con Playwright (`npm run test:e2e`). Hoy hay **1 smoke**
(`e2e/smoke-landing.spec.ts`) y el job de CI está **gateado**: solo corre si la
variable de repositorio `RUN_E2E == 'true'` y existen los secrets de Supabase
(`.github/workflows/ci.yml`). Si `RUN_E2E` no está cargada, el smoke **no corre
nunca** en CI — conviene activarlo apenas exista staging.

## Fase 1 (hoy) — read-only, sin datos

- `smoke-landing`: la landing carga, el CTA y el login existen.
- Corre contra `vite preview` en CI o contra `npm run dev` local.

## Fase 2 (pendiente) — requiere staging

Necesita un proyecto Supabase aparte con migraciones + seeds + cuentas de
prueba (admin / recepción / miembro con plan) y las env vars en CI:

1. `e2e/reservar-cancelar.spec.ts` — miembro reserva un slot y lo cancela a
   tiempo; el crédito vuelve (`membresia_movimientos`).
2. `e2e/checkin.spec.ts` — recepción crea reserva walk-in con check-in en un paso;
   "Llegando ahora" no muestra canceladas.
3. `e2e/recuperar-contrasena.spec.ts` — `/recuperar` responde igual exista o no
   el email; `/nueva-contrasena` sin sesión muestra "enlace no válido".
4. `e2e/admin-planes.spec.ts` — apagar "En venta" quita el plan del signup sin
   afectar a un miembro que lo tiene.

## Reglas

- Las cuentas de prueba viven en `.env.e2e` (no se commitea). Nunca usar cuentas
  reales ni la base de producción.
- Cada spec limpia lo que crea (o usa datos con prefijo `e2e-`).
- Antes de abrir un PR grande: `npm test && npm run lint && npm run build`; el
  e2e es adicional, no reemplazo de los 560+ tests unitarios.
