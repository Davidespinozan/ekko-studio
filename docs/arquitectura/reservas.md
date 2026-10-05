# Reservas y asistencia

## Autoridad
La tabla `reservas` y sus triggers son la verdad; el front solo llama RPC y pinta.
Estados: `confirmada`, `completada`, `cancelada` (la causó el miembro),
`cancelada_admin` (la causó el estudio), `no_show`. "Vivas" para ocupar un horario:
`confirmada` y `completada` (EXCLUDE `reservas_no_overlap`, `trg_un_set_a_la_vez`).

## Transiciones (todas en el servidor, atómicas)
- Crear: `reservar_recurso_atomic` (miembro) y `reservar_para_miembro_atomic`
  (recepción, sin anticipación mínima). Validan plan vivo, estudio permitido,
  invitados ≤ `reglas.max_invitados`, horario del estudio, continuas, tope diario,
  solape; `BEFORE INSERT`: duración válida, estudio en servicio, dentro de vigencia;
  `AFTER INSERT`: débito de crédito y aviso de confirmación.
- Cancelar: `cancelar_reserva_atomic(reserva, motivo, causa)`. El miembro solo a
  tiempo; el equipo indica causa `miembro` o `estudio`. El trigger
  `reservas_normalizar_cancelacion` asienta causa y tardanza con la ventana única
  `_cancelacion_min_horas` (default 24 h; igualdad = tarde). Miembro tarde: el
  crédito no vuelve. Estudio: vuelve. Extras pagados en la reserva: revisión
  financiera, sin reembolso automático.
- Reprogramar: `reprogramar_reserva`, una transacción: cancela como estudio, crea
  con las mismas reglas, traslada extras pagados (`invitados_extra_traslados`) y
  fichas, un solo aviso, auditoría. Nada parcial.
- Check-in: `check_in_atomic` (QR) y `check_in_manual_atomic`. Guardas en `reservas`:
  identidad y contrato (`exigir_identidad_al_ingresar`, cualquier entrada a
  `completada`), cuenta revocada (`reservas_bloquear_checkin_revocado`), auditoría
  de override. Estado de acceso: `_estado_membresia_checkin` (membresia.md).
- Corrección: `staff_corregir_asistencia`: `no_show` → `completada` tras iniciar
  la sesión (revierte penalización, nunca créditos), y `completada` → `confirmada`
  el mismo día. Una CANCELADA no se revive: se crea otra.
- No-show: cron `marcar_no_shows` (slot_fin + 60 min, sin check-in), condicionado
  por fila; penaliza según `config.penalizaciones` salvo que la asistencia fuera
  imposible por cuenta restringida o derecho terminado (queda `no_show` sin castigo).

## Disponibilidad e invitados
- La UI pide disponibilidad a `slots_ocupados()`, nunca lee `reservas` ajenas.
- Invitados incluidos (`invitados_count`) + extras pagados
  (`invitados_extra_pagados`, caché de `invitados_extra_pagos` + traslados, suma
  canónica `_extras_atribuidos`). Fichas en `reserva_invitados` por
  `registrar_ficha_invitado`, con tope = incluidos + extras. `capacidad_personas`
  del estudio es informativa.

## Dónde vive
RPC y triggers: últimas definiciones con `scripts/db-ultima-def.mjs`. Netlify:
`reception-*` (asistencia, no-show, invitados, estudio fuera de servicio),
`cron-no-shows`, `qr-*`. Front: `src/member/logic/reservaLogic.ts`,
`src/reception/lib/*`, `src/shared/components/reserva/`. Pruebas:
`src/__tests__/db/{r2a-reservas,r2b-terminacion,disponibilidad,invitados}.db.test.ts`.

## Decisiones que gobiernan lo ambiguo
Índice → "Reservas, asistencia y cancelación": EKKO-132/133/134, 121, 122, 118,
069/070, 014/031/058, 059/078, D1–D3.

## Fuera de este dominio
Qué plan da derecho (membresia.md); el dinero de los extras (dinero.md).
