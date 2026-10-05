# Índice de decisiones — EKKO

Esto NO es otro libro de decisiones. El único libro es [`DECISIONS.md`](../DECISIONS.md)
(raíz). Este índice sirve para encontrar QUÉ decisión gobierna una pregunta sin
leerlo completo.

Cómo usarlo: busca el tema, toma el ID y lee solo esa entrada:
`grep -n "EKKO-NNN" -A12 DECISIONS.md` (las series antiguas `D1`, `H3`, `L-01`… se
buscan igual, por su marcador). Entre paréntesis va la etiqueta original del dueño.
Si una entrada dice "sustituida", manda la que la sustituye. Una decisión no se
rediscute sin evidencia nueva.

## Dinero y evidencia financiera
- EKKO-112 (D7; sustituye a EKKO-028) — un reembolso no muta derechos: evidencia + revisión humana.
- EKKO-113 (D8) — disputas: evidencia y revisión; sin mutación automática.
- EKKO-126 (sustituye a EKKO-034) — libro económico: bruto, reversado, neto, sin resolver.
- EKKO-115 (D-01G-4) — proveniencia del valor solo hacia adelante; histórico `desconocido`.
- EKKO-108 (D9, D-01D-3, D-01D-5) — venta de mostrador con evidencia e idempotencia.
- EKKO-109 (D-01E-4) — tarjeta en mostrador; el servidor fija el monto.
- EKKO-117 (W-2) — pago de extras que no aplica: evidencia `no_aplicado` + revisión.
- EKKO-134 (D-01Q-2; extiende EKKO-090) — extras pagados en reserva cancelada: una revisión, sin reembolso.
- EKKO-127 (D-01O-1) — crédito que no se puede restaurar: una revisión, nunca pérdida silenciosa.
- EKKO-084 — ledgers inmutables por trigger. EKKO-044 — un pago único acredita una vez.
- EKKO-049 — la devolución vuelve a la membresía que pagó. EKKO-051 — a quien pagó no se le borra.
- EKKO-021 — paquetes fuera del MRR. EKKO-088 — el historial dice qué se cobró.

## Membresía y derecho
- EKKO-123 — el plan que da derechos es el de la membresía viva; el caché es display.
- EKKO-100, EKKO-101 — revocación persistente; Stripe no resucita membresías.
- EKKO-098, EKKO-099 — la cuenta manda en la puerta; política de check-in manual.
- EKKO-091, EKKO-048, EKKO-066 — sanción ≠ estado comercial; un cobro no la levanta; pausa ≠ sanción.
- EKKO-128 (D-01O-2) — no reservar después del fin efectivo; falta sin penalización si EKKO impidió asistir.
- EKKO-110 (D12, D-01F-4 a -7) — cambio de plan: reservas incompatibles bloquean; transición atómica.
- EKKO-125 — semántica de planes: slug inmutable, tipo/activo protegidos, `max_invitados` obligatorio.
- EKKO-036, EKKO-046 — reservar exige membresía viva; la pausa cuenta como viva.
- EKKO-030, EKKO-032 — la membresía se revalida en la puerta; estado `pausada`.
- EKKO-052 — `en_venta` se valida en el servidor.
- EKKO-045, EKKO-047 — recomprar nunca acorta; perder créditos exige confirmación en servidor.
- EKKO-057 — baja por staff; NO cancela reservas futuras. EKKO-041 — baja de suscripción vieja no castiga.
- EKKO-009, EKKO-013, EKKO-016, EKKO-026 — planes por créditos; validación de plan; `tiers_permitidos`; `en_venta`.
- EKKO-104 — vista de reconciliación de membresía (solo lectura).

## Reservas, asistencia y cancelación
- EKKO-132 (D-01Q-1) — la cancelación dice quién la causó; miembro tarde pierde el crédito.
- EKKO-133 (sustituye el default de EKKO-015) — una sola ventana de cancelación (24 h; igualdad = tarde).
- EKKO-121 (sustituye a EKKO-025) — transiciones de asistencia en servidor; una cancelada no revive.
- EKKO-122 (sustituye a D6 y EKKO-076) — reprogramar es una operación atómica, con traslado de extras.
- EKKO-118 (W-3), EKKO-116 (W-1) — la reserva es la verdad de sus invitados; capacidad informativa.
- EKKO-069, EKKO-070 — disponibilidad por `slots_ocupados()`; un solo set a la vez.
- EKKO-014, EKKO-031, EKKO-058 — penalización por no-show; tope diario; no-show durante la sesión.
- EKKO-038, EKKO-060, EKKO-061 — duración fijada por el estudio; "vigente"; el miembro cancela las suyas.
- EKKO-059, EKKO-078 — cancelación por el estudio en bitácora; el admin cancela por la RPC.
- Series antiguas: D1, D2, D3 (recepción), L-01, L-02 (zona horaria, check-in), H3 (cross-tenant).

## Stripe y cobro
- EKKO-129, EKKO-130 (D-01P-1) — sanción suspende el cobro; revocación cancela de inmediato.
- EKKO-131 — operaciones de cobro con evidencia durable y reintento.
- EKKO-105 (D-01A-1) — estado durable de los eventos del webhook.
- EKKO-106 — crear un Checkout no da derecho; lo da el evento financiero.
- EKKO-107 — idempotencia de lo que EKKO le pide a Stripe.
- EKKO-114 (D-01G-3) — desautorización de Connect: apaga el cobro del estudio, no derechos.
- EKKO-102 — facturas (basil) y atribución sin doble conteo. EKKO-050 — recibido ≠ procesado.
- EKKO-019, EKKO-043 — cuenta de Stripe compartida: se filtra por cuenta y por `metadata.app`; una sola lista de eventos.
- EKKO-007, EKKO-011, EKKO-029, EKKO-053 — billing, pago in-app, fee de plataforma, avisos de cobro.
- D4 — modelo de cobro (suscripción mensual por plan).

## Seguridad y autorización
- EKKO-124 — ser admin de la fila no autoriza a mutar invariantes por REST.
- EKKO-083 — nunca dejar el estudio sin admin activo. EKKO-039, EKKO-040 — staff inactivo sin poderes; alcance de recepción.
- EKKO-020 — privilegios de funciones y columnas. EKKO-042 — cuentas demo sin contraseña fija.
- EKKO-092, EKKO-093, EKKO-094, EKKO-095, EKKO-096, EKKO-097 — ficha de identidad por PATCH, contrato como evento, avatar como identidad, alta en Auth, correo único, sin `membresia_tier` por recepción.
- EKKO-010 — ficha de identidad y gate de ingreso. EKKO-086 — "Editar datos" en recepción es solo contacto.
- Series antiguas: C1, C2, H1, H4, H5, H6 (SEC-FIX), B1/B2, B4 (auditoría).

## Avisos y correo
- EKKO-111 — el correo dice la verdad: aceptado por el proveedor ≠ entregado.
- EKKO-073, EKKO-074, EKKO-027 — correo por despachador central; confirmación por trigger; avisos.
- EKKO-008, EKKO-033, EKKO-068 — web push; push central; push para staff. EKKO-081 — la campana es historial.

## Interfaz honesta
- EKKO-119 — un fallo al cargar no se muestra como vacío ni como éxito.
- EKKO-120 — no se afirma pago ni derecho antes de observarlo en el servidor.
- EKKO-023, EKKO-062 — fechas en la zona del estudio. Serie E-01..E-06 — nunca el error crudo.
- EKKO-063, EKKO-064, EKKO-065, EKKO-089 — plan actual visible; sondeo tras pagar; avisar antes; "contacta al estudio".

## Operación, pruebas y despliegue
- EKKO-135 (D-R2B-GATE-1) — límite explícito en la prueba que levanta una base; sin inflar timeouts.
- EKKO-035, EKKO-037, EKKO-085 — pruebas conductuales de la base; trigger de débito AFTER INSERT; checks SQL en CI.
- EKKO-012, EKKO-022 — crons de Netlify; plataforma. EKKO-103 — auditoría del ciclo de vida.
- D-006 — no consultar la base dentro de `onAuthStateChange`.

## Producto y panel
- EKKO-017, EKKO-018, EKKO-024, EKKO-055, EKKO-056 — acceso, ficha admin, reservas por recepción, asignar plan, ajuste de créditos.
- EKKO-071, EKKO-072, EKKO-075, EKKO-082, EKKO-087 — disponibilidad por sondeo, calendario, material, pago por hora, atajos de mostrador.
- EKKO-067, EKKO-079, EKKO-080 — banner de instalar, centro de pendientes, reset de contraseña del equipo.
- EKKO-054, EKKO-077 — la ficha decide por el estado de la MEMBRESÍA; la ficha admin reusa la tarjeta y modales de recepción.
- Series antiguas: D5, R3, R6 (recepción).
