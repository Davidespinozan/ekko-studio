# Pendientes por traer de SALA

SALA (`/Users/davidespinoza/sala-studio`, repo `Davidespinozan/sala-studio`) es el SaaS hermano: mismo stack (React + Vite + Supabase + Netlify Functions), pero para gyms con clases grupales y multi-tenant. Este archivo lista lo que SALA ya resolvió y a ekko le sirve.

**Esto no es copiar y pegar.** ekko es renta de estudios (1 miembro, 1 set, 1 slot) y tiene su propio modelo económico (`ventas_mostrador`, `libro_economico`, `payment_events`, `reversales_pago`, `audit_log`, `operation_id`). Hay que tomar el **diseño** de SALA y re-implementarlo sobre las tablas y convenciones de ekko. Respetar DECISIONS.md.

**Cómo usarlo:** "lee docs/DE_SALA.md y empecemos por el punto N". Al terminar, cambiar el estado a `hecho (<commit>)`.

Estados: `pendiente` · `en curso` · `hecho (<commit>)` · `descartado (motivo)`

Origen: comparación SALA vs ekko del 2026-10-07.

---

## 1. Caja + corte de caja — `pendiente`
**Qué hace en SALA:**
- Vista de pagos por periodo (Hoy, Ayer, 7 días, Este mes, en la zona horaria del negocio).
- Totales por método (efectivo, tarjeta, transferencia, online, cortesía); la cortesía no cuenta como ingreso. Export CSV.
- **Corte de caja:**
  - Por turno (hora de corte configurable, default 14:00) o por rango.
  - Fondo inicial, efectivo contado y diferencia.
  - Aviso si el rango se traslapa con un corte anterior.
  - Historial de cortes y ticket imprimible o compartible como imagen.
  - Datos del ticket configurables: razón social, RFC, teléfono, dirección.
- Recepción usa la misma vista con menos permisos: sin devoluciones y sin editar los datos del ticket.

**Por qué ekko lo necesita:** hoy no hay corte de caja ni lista de ventas de mostrador (las ventas viven en `ventas_mostrador`, pero no tienen pantalla).

**Ver en SALA:**
- `src/admin/pages/Caja.tsx`
- `CajaView` (componente compartido admin y recepción)
- `src/shared/components/CorteTicket.tsx`
- `src/shared/lib/recibo.ts` (`imprimirCorte`, `compartirCorteImagen`)
- RPCs `preview_corte_caja` y `hacer_corte_caja` (última versión en `supabase/migrations/20261005260000_branch_isolation_hardening.sql`)

**Adaptar:** leer de `ventas_mostrador` / `v_libro_economico` en lugar de `pagos`. Sin sucursales.

## 2. Devoluciones y correcciones desde la app — `pendiente`
**Qué hace en SALA:** por cada pago hay tres opciones, todas append-only (filas negativas que apuntan al pago original, nunca ediciones):
- **Devolución real** (dinero de vuelta).
- **Corrección** de un error (no cuenta como reembolso).
- **"Fue cortesía".**

Además:
- Permite montos parciales, con tope en lo que queda por devolver.
- **Corregir método** (reclasificar efectivo / tarjeta / transferencia sin mover dinero).
- Anular una venta de producto devuelve el stock.

**Por qué ekko lo necesita:** hoy las devoluciones solo se hacen en el dashboard de Stripe, y una venta de mostrador no se puede anular (está en STATUS como "ventas de mostrador sin evidencia de anulación").

**Ver en SALA:**
- RPCs `registrar_reembolso`, `reembolsar_como_cortesia`, `corregir_metodo_pago`
- Trigger `trg_pagos_append_only`
- Columna `pagos.revierte_pago_id`

**Adaptar:**
- Que el movimiento de reversa entre a `libro_economico` y a `reversales_pago`.
- Los pagos con Stripe solo se *registran*; el dinero se devuelve en Stripe y el webhook sigue siendo la evidencia.

## 3. "Por cobrar" (paga al llegar) — `pendiente`
**Qué hace en SALA:**
- Al asignar un plan se elige "pendiente": se crea un cargo pendiente y el plan queda listo.
- Recepción lo cobra después con un método de pago, o el admin lo cancela.
- Aparece en el Centro de Pendientes y en la ficha del socio.
- Aviso para no renovar dos veces el mismo plan si ya hay un pendiente (lección del caso Annie).

**Ver en SALA:**
- RPCs `registrar_cargo_pendiente`, `cobrar_cargo_pendiente`, `cancelar_cargo_pendiente`
- `src/admin/components/PorCobrarCard.tsx`
- `CargoPendienteRow`

## 4. Recibos — `pendiente`
**Qué hace en SALA:** recibo por pago para imprimir, compartir como imagen o mandar por WhatsApp con un link público firmado (`/recibo/<id>?t=`).

**Ver en SALA:**
- `src/shared/components/ReciboModal.tsx`
- `src/shared/components/ReciboView.tsx`
- Netlify Functions `recibo-token` y `recibo`

## 5. Importar miembros por CSV — `pendiente`
**Qué hace en SALA:**
- Mapea las columnas solo (nombre, email, teléfono, plan, vencimiento, clases restantes, nacimiento).
- Hace corresponder cada plan del archivo con un plan del sistema.
- Acepta fechas dd/mm/yyyy.
- Trata emails de relleno o duplicados como "sin correo".
- Lotes de hasta 2000; devuelve un resumen de creados, saltados y errores.
- Crea miembros sin login más su membresía con vencimiento. No cobra.

**Ver en SALA:**
- `src/admin/components/ImportarMiembrosModal.tsx`
- Netlify Function `importar-miembros`
- RPC `importar_miembros`
- Activación del miembro: `/activar`, `activar-cuenta`, `reclamar-cuenta`

**Gotchas que SALA ya pagó:**
- `email` es NOT NULL.
- Un trigger vincula a los huérfanos cuando el socio reclama su cuenta.

## 6. Reportes con periodo y exportar PDF — `pendiente`
**Qué hace en SALA:**
- Selector de periodo (semana, mes, 30 días, 90 días) con comparación contra el periodo anterior.
- Exportar a PDF con `window.print()` y un encabezado con la marca.
- Retención por cohortes.

**Por qué ekko lo necesita:** hoy sus ventanas de tiempo son fijas y no hay forma de exportar.

**Ver en SALA:** `src/admin/pages/Reportes.tsx`, `src/admin/hooks/useReportes*.ts`

**Gotcha:** html2canvas se rompe con `color-mix`.

## 7. Bitácora global — `pendiente`
**Qué hace en SALA:** una página de admin con todo lo que hizo el staff (quién, rol, acción, entidad, socio, resumen), con búsqueda y filtro por entidad.

**Por qué ekko lo necesita:** ekko ya escribe en `audit_log`, pero solo lo muestra por miembro.

**Ver en SALA:** `src/admin/pages/Bitacora.tsx`, `src/admin/hooks/useBitacora.ts`

**Adaptar:** leer de `audit_log`; no hace falta backend nuevo.

## 8. Colores y tipografía de marca editables — `pendiente`
**Qué hace en SALA:** color primario y de acento con vista previa de la paleta, fuentes, tamaño general del texto e isotipo (que también sirve de favicon e icono PWA).

**Por qué ekko lo necesita:** ekko tiene `tenants.branding` sin interfaz para editarlo.

**Ver en SALA:** `src/admin/pages/AjustesMarca.tsx`

**Regla de SALA:** la UI usa solo el primario, el acento y los neutrales.

---

## No traer (no aplica al modelo de renta de estudios)
- Multi-sucursal.
- Huella digital.
- Agenda y horarios de clases.
- Mapa de lugares.
- Lista de espera.
- Instructores.
- Multas de re-reserva.

Para reconsiderar alguno, mover la línea arriba con su motivo.

## Avisos de SALA que le pueden importar a ekko
- **2026-10-07:** cancelar tarde y re-reservar el mismo slot cobraba 2 créditos. SALA lo resolvió con un trigger sobre el ledger (`supabase/migrations/20261007190000_recancelacion_traslada_credito.sql`). Revisar si ekko tiene el mismo hueco (`creditos_debitar_al_reservar` / `creditos_devolver_al_cancelar`).
