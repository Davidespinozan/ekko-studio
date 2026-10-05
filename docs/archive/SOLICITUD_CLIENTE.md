> **DOCUMENTO HISTÓRICO (archivado 2026-10-05).** Es evidencia de cómo se pensó o auditó algo en su momento; no describe el estado actual ni autoriza trabajo. Vigente: `docs/STATUS.md` (estado), `DECISIONS.md` (decisiones), `docs/ARCHITECTURE.md` (arquitectura).

# Solicitud de cambios del cliente (septiembre 2026) — estado

> "Solicitud de cambios a ekkostudio.app", Lic. Juan Carlos Quevedo González (Gerente
> General). Cinco puntos. Implementado el 2026-09-20 en la rama `sprint-0-hotfixes`
> (SIN commitear ni subir). Decisiones: `DECISIONS.md` EKKO-069…075.
> Verificado: `tsc` · `lint` · `build` · 846 tests · 87 migraciones aplican en limpio.

## Bug previo que destapó el punto 3

**Un miembro no veía los horarios ocupados por OTROS miembros.** La grilla de Reservar
leía la tabla `reservas`, y la policy `reservas_read_self` solo le deja ver las suyas.
Un horario tomado se pintaba libre y el miembro se enteraba al confirmar. Verificado
ejecutándolo (A reserva, B consulta ese set: 0 filas). Arreglado con la RPC
`slots_ocupados` (devuelve solo intervalos: ni quién ni folio).

## 1. Agregar al calendario — HECHO

- `src/shared/lib/calendario.ts` (`.ics` RFC 5545 + enlace de Google) y
  `member/components/AgregarAlCalendario.tsx`. Sin backend.
- La invitación lleva: fecha y hora, set, duración, ubicación, folio, invitados, enlace
  al QR y contacto (WhatsApp / correo). Avisa 1 h antes. UID estable: agregarla dos
  veces no la duplica.
- Aparece **al terminar de reservar** (ahora se lleva al miembro al detalle de su
  reserva, no al inicio) y siempre en la pantalla del QR.
- **Necesita del estudio:** dirección en Admin → Landing (pie de página) y WhatsApp en
  Admin → Contacto. Si faltan, la invitación sale sin ellos.

## 2. Opciones de pago — Apple Pay / Google Pay listos para activar

- Tarjeta de crédito y débito (Visa, Mastercard, Amex), cobro recurrente, confirmación
  automática, consulta de estado y cancelación **ya existían**.
- Apple Pay y Google Pay **no requieren código** (PaymentElement +
  `automatic_payment_methods`). Falta registrar el dominio en la cuenta conectada del
  estudio: `scripts/stripe-wallets-dominio.mjs` (ver `STRIPE.md`). **No se ejecutó**:
  necesita la llave live y el sitio publicado.
- **"Pago por hora" en un solo flujo: HECHO.** Sin plan o sin saldo, tocar una hora
  ofrece comprar el paquete que alcance (normalmente "Sesión suelta") y la reserva
  queda hecha al acreditarse el pago (`src/member/logic/sesionSuelta.ts`).

## 3. Bloqueo simultáneo de sets — HECHO

- `config.reserva.sets_exclusivos` (Admin → Reglas → "Un solo set a la vez").
  **Encendido para EKKO Studio** por la migración.
- Se hace cumplir en la BASE (trigger `reservas_un_set_a_la_vez` + candado por estudio
  para reservas simultáneas): cubre la app, recepción y cualquier cambio de estado.
  Error `EKKO_ESTUDIO_EN_USO`.
- La grilla marca esos horarios como "Otro set en uso a esa hora".
- "Tiempo real": la grilla se refresca sola cada 20 s mientras está visible y al volver
  a la pestaña (por sondeo, no por Realtime: Realtime respeta RLS y un miembro no recibe
  cambios en reservas ajenas). Si alguien se adelanta, al confirmar se avisa y la grilla
  se actualiza al instante.
- Reprogramar desde recepción respeta la regla (mover de set a la misma hora funciona).
- **Preguntas abiertas al cliente:** ¿todos los sets se bloquean entre sí, o alguno
  puede convivir (p. ej. foto sin audio)? ¿Hace falta margen entre sesiones?

## 4. Confirmaciones y notificaciones — HECHO (el correo espera a Resend)

- Nuevo aviso **"Reserva confirmada"** al reservar (antes no existía ni en la app), con
  set, fecha y hora del estudio, duración, folio y enlace al QR. También si agenda
  recepción. Y constancia cuando el miembro cancela la suya.
- `cron-email` (cada 2 min): manda por correo los avisos de la app que lo ameritan —
  reserva confirmada/cancelada, membresía en pausa / reanudada / baja, créditos
  ajustados, material disponible, avisos manuales. Los de cobro ya tenían su correo.
- Corregido: la hora del aviso de cancelación salía en UTC.
- **Necesita:** cuenta de Resend + dominio `ekkostudio.app` verificado + env
  `RESEND_API_KEY` y `EKKO_EMAIL_FROM`. Sin eso el cron no hace nada (y no marca nada
  como enviado: al configurarlo sale lo de las últimas 6 h, no una ráfaga vieja).
- "Cambio de horario": una reprogramación llega como UN aviso ("Era … Ahora es …"),
  por app y por correo (`staff_avisar_reprogramacion`, migración `20260920230000`).

## 5. Entrega y descarga del material — HECHO

- Staff: en la ficha del miembro (recepción), cada sesión tiene **Material** → subir
  archivo (hasta 500 MB) o **pegar enlace** (Drive, Dropbox, Frame.io) para video
  pesado; vigencia en días (default 30, `config.material.dias_disponible`; 0 = sin
  vencimiento); retirar; y **"Avisar que ya está listo"** → UN aviso por tanda (app +
  correo), no uno por archivo.
- Miembro: **Perfil → Mi material** (`/app/material`): agrupado por sesión (fecha, set,
  folio), tamaño, días que le quedan, descargar.
- Seguridad: bucket privado; el miembro solo ve y descarga lo suyo y lo vigente — se
  hace cumplir también en Storage (sin fila vigente no se puede firmar la URL ni con la
  ruta exacta). Escrituras solo por RPC con auditoría.
- `cron-material-vencido` (diario) libera el espacio 7 días después de vencer.
- **Falta / a decidir con el cliente:** tamaño real de los archivos (si pasan de ~500 MB
  de forma habitual conviene subida por partes o almacenamiento externo tipo R2; hoy el
  camino para eso es el enlace) · plan de Supabase (límite por archivo y costo de
  almacenamiento/descarga). El modal de material está en recepción Y en la ficha
  admin del miembro (columna "Material" de sus reservas).

## Para subir esto (David)

Migraciones nuevas, después de las 22 anteriores y en orden:
`20260920200000` (disponibilidad + sets) · `20260920210000` (avisos + correo) ·
`20260920220000` (material) · `20260920230000` (aviso de cambio de horario). Functions nuevas: `cron-email`, `cron-material-vencido`.
Luego: `scripts/stripe-wallets-dominio.mjs` con la llave live, y cargar las env de Resend.
