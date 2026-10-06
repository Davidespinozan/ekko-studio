# Plataforma y tenant

Qué es estable aquí: cómo se parametriza un estudio, quién puede hacer qué y qué
protege la base. Procede de la fundación del kernel multi-tenant (historia en
`docs/archive/KERNEL.md`); aquí solo lo que sigue vigente.

## Tenant
- Todo lleva `tenant_id`; RLS filtra por tenant y rol (`get_my_tenant_id()`,
  `is_admin()`, `is_recepcionista()`, `get_my_rol()` en `supabase/migrations`).
- Las reglas variables viven en `tenants.config` (jsonb): `reserva.*` (duración,
  anticipación, ventana de cancelación, sets exclusivos, tope diario, precio de
  invitado extra), `penalizaciones.*`, `contacto.*`, `landing.*`, `membresia.*`,
  `acceso.*`. La marca en `tenants.branding`. Config ≠ branding.
- Consumo en el front SIEMPRE por un hook con defaults explícitos (`useTenant`,
  `useLandingConfig`, `useReglaCancelacion`…), nunca leyendo el jsonb a mano. Los
  componentes no hardcodean nombre, ciudad ni WhatsApp del estudio. En el servidor,
  los defaults de reglas viven en una sola función SQL (p. ej.
  `_cancelacion_min_horas`) para que front y base no diverjan.
- Stripe Connect: cada estudio tiene `tenants.stripe_account_id`; la cuenta de
  plataforma es compartida con otros productos del dueño, por eso el webhook
  filtra por cuenta conectada y `metadata.app = 'ekko'`.

## Cuentas y roles
- `usuarios` extiende `auth.users` (trigger de alta). Roles: `miembro`,
  `recepcionista`, `admin`. Estados: `pendiente_onboarding`, `pendiente_pago`,
  `activo`, `suspendido`, `cancelado`, `revocado`.
- Sanción (`sancionado_at`) y revocación son estados de ACCESO, no comerciales; los
  fija el servidor (`reception-update-member`, `restaurar_acceso_revocado`) y el
  trigger `usuarios_sancion_manda` los mantiene. Su efecto en el cobro está en
  `membresia.md`.
- Columnas de negocio de `usuarios` (rol, plan cacheado, puntero de membresía,
  penalización, sanción, correo, contrato) no se cambian por REST, ni siquiera
  siendo admin: trigger `proteger_columnas_privilegiadas_usuarios`. Permitido por
  REST: nombre, teléfono, avatar, notas del admin, revocar a staff.
- RLS ≠ privacidad de columnas (PKG-06D, EKKO-143): el cliente (`authenticated`,
  `anon`) tiene SELECT por COLUMNAS en `usuarios` (sin `notas_admin`,
  `sancion_motivo`, `acceso_autorizado_*`) y en `reservas` (sin `observaciones`,
  `qr_token_hash`); por eso ninguna lectura del cliente usa `select('*')` sobre
  ellas (`src/shared/lib/columnas.ts`). Lo interno lo lee el staff por RPC con
  guardia (`staff_datos_internos_cuenta`, `staff_observaciones_reserva`) y la
  búsqueda del panel es `buscar_cuentas_staff` con el texto como parámetro.
- Datos sensibles aparte: `usuarios_datos_privados` (solo dueño y admin lectura).
- Nunca se deja un estudio sin admin activo (`count_admins_activos`).
- Operaciones compuestas de cuenta (PKG-06A, EKKO-142): alta, cambio de rol, baja,
  reset de contraseña y edición por staff tienen su parte LOCAL en una RPC de
  servicio (`cuenta_alta_preparar`/`cuenta_alta_finalizar`, `cuenta_cambiar_rol`,
  `cuenta_eliminar`, `cuenta_password_reseteada`, `staff_actualizar_cuenta`) que
  corre en una transacción con el actor explícito validado (solo service_role las
  ejecuta: el actor no se forja) y publica ese actor en la transacción para que los
  triggers de auditoría de R1 lo vean. Lo que toca al proveedor de Auth queda fuera
  y la función de Netlify lo ordena: preparar → Auth → finalizar; Auth → copia local
  del correo. No hay atomicidad distribuida: hay orden seguro, compensación por
  propiedad (solo se revierte lo que esa operación creó) y respuesta parcial honesta.
- El correo no prueba identidad: el trigger de alta vincula un perfil sin acceso solo
  si no tiene historial durable (`cuenta_historial_durable`) o si un staff lo
  autorizó sobre ESE perfil (`acceso_autorizado_at/por`). Borrado físico solo para
  cuentas sin historial ni huella como staff (D-FIN-1 = A); lo demás se revoca.

## Identidad y puerta
- Ficha de identidad (foto, datos, INE) y contrato firmado condicionan el ingreso;
  el QR se emite y verifica en `qr-issue` / `qr-verify` y el estado de acceso lo
  calcula `_estado_membresia_checkin` (ver `reservas.md`).

## Decisiones que gobiernan lo ambiguo
Índice → "Seguridad y autorización": EKKO-124, EKKO-083, EKKO-039/040, EKKO-020,
EKKO-091 a EKKO-097, series C/H/B.

## Fuera de este dominio
Reglas de reserva (reservas.md), derecho y cobro (membresia.md), dinero (dinero.md).
