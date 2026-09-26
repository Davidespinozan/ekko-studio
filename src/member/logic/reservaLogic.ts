/**
 * Lógica pura de reservas. Sin React, sin Supabase.
 * Testeable. Toda la lógica del cliente que decide qué mostrar/permitir.
 *
 * NOTA: la fuente de verdad sigue siendo el RPC `reservar_recurso_atomic`.
 * Esta capa cliente es solo para UX (no mostrar slots inválidos al usuario).
 */

import type { Database } from '@shared/types/database';
import {
  partesEnZona,
  fechaISOEnZona,
  sumarDiasISO,
  diasEntreISO,
  diaSemanaDeFechaISO,
  instanteDeFechaHoraEnZona,
  formatHoraEnZona,
  formatFechaEnZona
} from '@shared/lib/timezone';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

export interface Slot {
  inicio: Date;
  fin: Date;
  disponible: boolean;
  /** 'otro_set' = el horario está libre en ESTE set, pero el estudio graba un set a la vez y hay otro en uso. */
  razon?: 'ocupado' | 'otro_set' | 'pasado' | 'anticipacion_insuficiente' | 'continuo' | 'fuera_horario';
}

/**
 * Un intervalo que bloquea el set que se está mirando (lo devuelve la RPC
 * `slots_ocupados`). `mismo_set: false` = lo ocupa OTRO set y el estudio graba
 * uno a la vez. `slot_fin`/`mismo_set` son opcionales para no romper a quien
 * todavía pase solo `slot_inicio`.
 */
export interface IntervaloOcupado {
  slot_inicio: string;
  slot_fin?: string | null;
  mismo_set?: boolean | null;
}

export interface HorarioBloque {
  dia: string;        // 'lunes' | 'martes' | ... | 'domingo'
  inicio: string;     // 'HH:mm' ej '09:00'
  fin: string;        // 'HH:mm' ej '22:00'
}

export interface TenantReservaConfig {
  duracion_default_min: number;
  cupos_por_recurso: number;
  permitir_continuas: boolean;
  anticipacion_min_horas: number;
  anticipacion_max_dias: number;
  ventana_check_in_min: number;
}

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;

/**
 * Nombre en español (sin tildes, como recursos.horarios) del día en que cae un
 * instante EN LA ZONA DEL ESTUDIO — no en la del navegador.
 */
export function diaNombre(date: Date): string {
  return DIAS_ES[partesEnZona(date).dow];
}

/** Ídem para una fecha de calendario 'YYYY-MM-DD'. */
export function diaNombreDeFechaISO(fechaISO: string): string {
  return DIAS_ES[diaSemanaDeFechaISO(fechaISO)];
}

/**
 * Combina una fecha (YYYY-MM-DD) con una hora de pared (HH:mm) DEL ESTUDIO y
 * devuelve el instante UTC. Antes se construía en la zona del navegador: un
 * miembro o el dueño desde otra zona veían los slots corridos.
 */
export function combinarFechaHora(fechaISO: string, horaHHmm: string): Date {
  return instanteDeFechaHoraEnZona(fechaISO, horaHHmm);
}

/**
 * Genera los slots disponibles para un recurso en una fecha específica.
 *
 * Considera:
 * - Horario del recurso (recursos.horarios) para ese día de semana
 * - Reservas ya activas en ese recurso (no disponibles)
 * - Anticipación mínima del tenant (no reservar muy cerca)
 * - Reservas continuas del propio usuario (si tenant prohíbe continuas)
 *
 * @param recurso El recurso seleccionado
 * @param fechaISO Fecha objetivo en formato 'YYYY-MM-DD'
 * @param config Reglas del tenant
 * @param reservasDelRecurso Reservas ya activas en ese recurso (cualquier usuario)
 * @param reservasDelUsuario Reservas ya activas del usuario (cualquier recurso) — para regla continuas
 * @param ahora Fecha actual (inyectable para testing)
 */
export function generarSlotsDisponibles(
  recurso: Recurso,
  fechaISO: string,
  config: TenantReservaConfig,
  reservasDelRecurso: IntervaloOcupado[],
  reservasDelUsuario: Pick<Reserva, 'slot_inicio'>[],
  ahora: Date = new Date(),
  opciones: { permitirEnCurso?: boolean } = {}
): Slot[] {
  const horarios = (recurso.horarios as unknown as HorarioBloque[]) ?? [];
  const diaSemana = diaNombreDeFechaISO(fechaISO);

  // Encontrar bloques de horario para ese día
  const bloquesDia = horarios.filter((b) => b.dia === diaSemana);
  if (bloquesDia.length === 0) return [];

  const slots: Slot[] = [];
  const duracion = config.duracion_default_min;
  const anticipacionMs = config.anticipacion_min_horas * 60 * 60 * 1000;
  const limiteAnticipacion = new Date(ahora.getTime() + anticipacionMs);

  // Intervalos ocupados. Se compara por TRASLAPE, no por igualdad de hora de
  // inicio: con "un solo set a la vez" el intervalo puede venir de OTRO set, y
  // recepción puede haber reservado una duración distinta del default. Sin
  // `slot_fin` (datos viejos) se asume la duración del estudio.
  const ocupados = reservasDelRecurso.map((r) => {
    const ini = new Date(r.slot_inicio).getTime();
    const fin = r.slot_fin ? new Date(r.slot_fin).getTime() : ini + duracion * 60_000;
    return { ini, fin, mismoSet: r.mismo_set !== false };
  });

  // Set de slots del usuario (para detectar continuos si está prohibido)
  const slotsUsuario = new Set(reservasDelUsuario.map((r) => new Date(r.slot_inicio).getTime()));

  for (const bloque of bloquesDia) {
    const inicioBloque = combinarFechaHora(fechaISO, bloque.inicio);
    const finBloque = combinarFechaHora(fechaISO, bloque.fin);

    let cursor = new Date(inicioBloque);
    while (cursor.getTime() + duracion * 60_000 <= finBloque.getTime()) {
      const slotInicio = new Date(cursor);
      const slotFin = new Date(cursor.getTime() + duracion * 60_000);
      const slotInicioMs = slotInicio.getTime();

      let disponible = true;
      let razon: Slot['razon'] | undefined;

      // Recepción (permitirEnCurso): una sesión que YA empezó pero no terminó
      // sigue reservable — el walk-in que llega 10 min tarde a su hora. El
      // backend de recepción no valida pasado/anticipación (D1) y el check-in
      // manual acepta hasta slot_fin + 60 min.
      const yaPaso = opciones.permitirEnCurso ? slotFin <= ahora : slotInicio < ahora;
      if (yaPaso) {
        disponible = false;
        razon = 'pasado';
      } else if (!opciones.permitirEnCurso && slotInicio < limiteAnticipacion) {
        disponible = false;
        razon = 'anticipacion_insuficiente';
      } else if (ocupados.some((o) => o.ini < slotFin.getTime() && o.fin > slotInicioMs)) {
        disponible = false;
        const choque = ocupados.filter((o) => o.ini < slotFin.getTime() && o.fin > slotInicioMs);
        razon = choque.some((o) => o.mismoSet) ? 'ocupado' : 'otro_set';
      } else if (!config.permitir_continuas) {
        // Validar que el usuario no tenga reserva en slot adyacente (±duracion)
        const slotAnteriorMs = slotInicioMs - duracion * 60_000;
        const slotSiguienteMs = slotInicioMs + duracion * 60_000;
        if (slotsUsuario.has(slotAnteriorMs) || slotsUsuario.has(slotSiguienteMs)) {
          disponible = false;
          razon = 'continuo';
        }
      }

      slots.push({ inicio: slotInicio, fin: slotFin, disponible, razon });

      // Avanzar al siguiente slot (duración + 0 gap)
      cursor = new Date(cursor.getTime() + duracion * 60_000);
    }
  }

  return slots;
}

/**
 * Genera la lista de fechas reservables a partir de hoy según anticipación_max_dias.
 */
export function generarFechasReservables(
  config: TenantReservaConfig,
  ahora: Date = new Date()
): { fechaISO: string; date: Date; label: string }[] {
  const fechas: { fechaISO: string; date: Date; label: string }[] = [];
  // "Hoy" es el día del ESTUDIO, no el del navegador.
  const hoyISO = fechaISOEnZona(ahora);

  for (let i = 0; i < config.anticipacion_max_dias; i++) {
    const fechaISO = sumarDiasISO(hoyISO, i);
    fechas.push({
      fechaISO,
      date: instanteDeFechaHoraEnZona(fechaISO),
      label: formatDateLabelISO(fechaISO, hoyISO)
    });
  }

  return fechas;
}

/**
 * ¿El tier del usuario puede reservar ESTE recurso? Un estudio Pro
 * (costo_creditos ≥ 2) no lista 'esencial' en tiers_permitidos, así que Esencial
 * queda fuera; Premium y los paquetes sí. Sin plan → solo recursos abiertos.
 */
export function puedeReservarRecurso(
  recurso: Pick<Recurso, 'tiers_permitidos'>,
  membresia_tier: string | null
): boolean {
  // Misma regla que _recurso_permite_tier en la base: lista vacía = abierto a
  // cualquier plan (incluso sin plan); con lista = solo esos planes.
  if (recurso.tiers_permitidos.length === 0) return true;
  if (!membresia_tier) return false;
  return recurso.tiers_permitidos.includes(membresia_tier);
}

/**
 * Filtra recursos accesibles según el tier del usuario.
 */
export function filtrarRecursosPorTier(
  recursos: Recurso[],
  membresia_tier: string | null
): Recurso[] {
  return recursos.filter((r) => puedeReservarRecurso(r, membresia_tier));
}

/**
 * Formato YYYY-MM-DD del día en que cae el instante EN LA ZONA DEL ESTUDIO.
 */
export function formatDateISO(d: Date): string {
  return fechaISOEnZona(d);
}

/**
 * Label legible para selector de fecha ('Hoy', 'Mañana', 'Lunes 18 may').
 */
export function formatDateLabel(d: Date, ahora: Date = new Date()): string {
  return formatDateLabelISO(fechaISOEnZona(d), fechaISOEnZona(ahora));
}

export function formatDateLabelISO(fechaISO: string, hoyISO: string): string {
  const diff = diasEntreISO(hoyISO, fechaISO);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  const dia = DIAS_ES[diaSemanaDeFechaISO(fechaISO)];
  const num = Number(fechaISO.slice(8, 10));
  const mes = formatFechaEnZona(instanteDeFechaHoraEnZona(fechaISO, '12:00'), { month: 'short' });
  return `${capitalize(dia)} ${num} ${mes}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Formato HH:mm (hora de pared del estudio).
 */
export function formatHora(d: Date): string {
  return formatHoraEnZona(d);
}

/**
 * Traduce errores del RPC reservar_recurso_atomic a mensajes user-friendly.
 */
export function traducirErrorRPC(message: string): string {
  if (message.includes('EKKO_USUARIO_INACTIVO')) return 'Tu membresía no está activa. Contacta al administrador.';
  if (message.includes('EKKO_USUARIO_BLOQUEADO')) return 'Tu cuenta tiene una restricción activa.';
  if (message.includes('EKKO_RECURSO_NO_EXISTE')) return 'El estudio no está disponible.';
  if (message.includes('EKKO_RECURSO_INACTIVO')) return 'Este estudio no está disponible.';
  if (message.includes('EKKO_RECURSO_FUERA_SERVICIO')) return 'Este estudio está temporalmente fuera de servicio.';
  if (message.includes('EKKO_TIER_NO_PERMITIDO')) return 'Tu plan no tiene acceso a este estudio.';
  if (message.includes('EKKO_TIER_NO_PERMITE')) return 'Tu plan no incluye acceso a este estudio.';
  if (message.includes('EKKO_INVITADOS_EXCEDEN')) return 'Tu plan no permite tantos invitados.';
  if (message.includes('EKKO_INVITADOS_INVALIDOS')) return 'Número de invitados inválido.';
  if (message.includes('EKKO_ANTICIPACION_INSUFICIENTE')) return 'Necesitas reservar con más anticipación.';
  if (message.includes('EKKO_ANTICIPACION_EXCESIVA')) return 'No puedes reservar tan lejos en el futuro.';
  if (message.includes('EKKO_CONTINUAS_NO_PERMITIDAS')) return 'No puedes reservar horas consecutivas.';
  if (message.includes('EKKO_CONTINUA')) return 'No puedes reservar horas consecutivas.';
  if (message.includes('EKKO_LIMITE_DIARIO')) return 'Alcanzaste el máximo de sesiones que puedes reservar ese día. Elige otro día.';
  if (message.includes('EKKO_IDENTIDAD_INCOMPLETA')) return 'Falta capturar la ficha de identidad (foto, datos, INE) antes de dar ingreso.';
  if (message.includes('EKKO_CONTRATO_PENDIENTE')) return 'El miembro debe firmar el contrato antes de dar ingreso.';
  if (message.includes('EKKO_SIN_MEMBRESIA')) return 'No tienes un plan vigente. Elige un plan o paquete en tu perfil para reservar.';
  if (message.includes('EKKO_DURACION_INVALIDA')) return 'La duración de la sesión no es válida para este estudio.';
  if (message.includes('EKKO_SIN_CREDITOS')) return 'No te quedan créditos. Compra un paquete para reservar.';
  if (message.includes('EKKO_MEMBRESIA_VENCIDA')) return 'Tu paquete venció. Renueva para seguir reservando.';
  if (message.includes('EKKO_ESTUDIO_EN_USO')) return 'A esa hora ya hay una grabación en otro set. El estudio graba un set a la vez para cuidar el audio: elige otro horario.';
  if (message.includes('EKKO_SLOT_OCUPADO')) return 'Este horario acaba de ser tomado por otro miembro. Elige otro.';
  if (message.includes('EKKO_RESERVA_NO_EXISTE')) return 'La reserva no existe.';
  if (message.includes('EKKO_NO_AUTORIZADO')) return 'No puedes hacer esta acción.';
  if (message.includes('EKKO_CANCELACION_TARDIA')) return 'Ya no puedes cancelar esta reserva por tu cuenta. Contacta a recepción.';
  if (message.includes('EKKO_RESERVA_NO_CANCELABLE')) return 'Esta reserva no se puede cancelar.';
  if (message.includes('EKKO_RESERVA_PASADA')) return 'No puedes cancelar una reserva que ya pasó.';
  if (message.includes('EKKO_FUERA_DE_HORARIO')) return 'Ese horario está fuera del horario del estudio.';
  if (message.includes('EKKO_TENANT_DIFERENTE')) return 'Esa reserva pertenece a otro estudio.';
  // EKKO_NO_AUTH va DESPUÉS de EKKO_NO_AUTORIZADO: 'EKKO_NO_AUTH' es
  // substring de 'EKKO_NO_AUTORIZADO' y matchearía de más si fuera antes.
  if (message.includes('EKKO_NO_AUTH')) return 'Tu sesión expiró. Inicia sesión de nuevo.';
  // Fallback (ERROR-UI-FIX E-04): nunca exponer el mensaje crudo de
  // Postgres/Supabase/HTTP. Mismo criterio que traducirErrorReserva.
  return 'No se pudo completar la operación. Intenta de nuevo.';
}
