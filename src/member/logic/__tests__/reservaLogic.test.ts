import { describe, it, expect } from 'vitest';
import { instanteEnZona, partesEnZona } from '@shared/lib/timezone';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  filtrarRecursosPorTier,
  puedeReservarRecurso,
  traducirErrorRPC,
  diaNombre,
  combinarFechaHora,
  formatDateISO,
  type TenantReservaConfig
} from '../reservaLogic';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

const baseConfig: TenantReservaConfig = {
  duracion_default_min: 60,
  cupos_por_recurso: 1,
  permitir_continuas: false,
  anticipacion_min_horas: 24,
  anticipacion_max_dias: 30,
  ventana_check_in_min: 15
};

function makeRecurso(overrides: Partial<Recurso> = {}): Recurso {
  return {
    id: 'rec-1',
    tenant_id: 'tenant-1',
    slug: 'estudio-1',
    nombre: 'Estudio 1',
    descripcion: null,
    tipo: 'estudio_individual',
    cupos: 1,
    horarios: [
      { dia: 'lunes', inicio: '09:00', fin: '12:00' },
      { dia: 'lunes', inicio: '14:00', fin: '18:00' }
    ],
    tiers_permitidos: ['basica', 'pro'],
    fotos_urls: [],
    video_url: null,
    activo: true,
    fuera_de_servicio: false,
    fuera_de_servicio_motivo: null,
    orden: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    capacidad_personas: null,
    costo_creditos: 1,
    max_invitados_extra: 4,
    equipo_incluido: null,
    estilo_visual: null,
    foto_url: null,
    tipo_contenido: null,
    ...overrides
  };
}

describe('generarSlotsDisponibles', () => {
  it('genera slots de 60 min en bloques separados de horario', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 10, 8, 0); // domingo 10 may 2026 8am
    const fecha = '2026-05-11'; // lunes
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    // 9-12: 3 slots (9-10, 10-11, 11-12)
    // 14-18: 4 slots (14-15, 15-16, 16-17, 17-18)
    expect(slots).toHaveLength(7);
    expect(partesEnZona(slots[0].inicio).hour).toBe(9);
    expect(partesEnZona(slots[2].inicio).hour).toBe(11);
    expect(partesEnZona(slots[3].inicio).hour).toBe(14);
    expect(partesEnZona(slots[6].inicio).hour).toBe(17);
  });

  it('marca slots pasados como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 11, 11, 0); // lunes 11am
    const fecha = '2026-05-11';
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    expect(slots[0].disponible).toBe(false); // 9am ya pasó
    expect(slots[0].razon).toBe('pasado');
  });

  it('marca slots dentro de anticipación mínima como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 11, 8, 0); // lunes 8am
    const fecha = '2026-05-11';
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], ahora);

    // Con anticipación de 24h, todos los slots de lunes están dentro de las 24h
    const tieneAnticipacionInsuficiente = slots.some(
      (s) => !s.disponible && s.razon === 'anticipacion_insuficiente'
    );
    expect(tieneAnticipacionInsuficiente).toBe(true);
  });

  it('marca slots ocupados como no disponibles', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 10, 8, 0); // dom 8am
    const fecha = '2026-05-11';
    const slotOcupado = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      baseConfig,
      [{ slot_inicio: slotOcupado.toISOString() }],
      [],
      ahora
    );

    const slot10 = slots.find((s) => partesEnZona(s.inicio).hour === 10);
    expect(slot10?.disponible).toBe(false);
    expect(slot10?.razon).toBe('ocupado');
  });

  it('marca slots continuos del usuario como no disponibles cuando regla está activa', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 10, 8, 0);
    const fecha = '2026-05-11';
    const usuarioYaReservadoEn10am = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      baseConfig, // permitir_continuas: false
      [],
      [{ slot_inicio: usuarioYaReservadoEn10am.toISOString() }],
      ahora
    );

    // slot 9-10 (anterior) y 11-12 (siguiente) deberían estar bloqueados como 'continuo'
    const slot9 = slots.find((s) => partesEnZona(s.inicio).hour === 9);
    const slot11 = slots.find((s) => partesEnZona(s.inicio).hour === 11);
    expect(slot9?.razon).toBe('continuo');
    expect(slot11?.razon).toBe('continuo');
  });

  it('permite continuos si tenant los permite', () => {
    const recurso = makeRecurso();
    const ahora = instanteEnZona(2026, 4, 10, 8, 0);
    const fecha = '2026-05-11';
    const configPermite = { ...baseConfig, permitir_continuas: true };
    const usuarioYaReservadoEn10am = combinarFechaHora(fecha, '10:00');

    const slots = generarSlotsDisponibles(
      recurso,
      fecha,
      configPermite,
      [],
      [{ slot_inicio: usuarioYaReservadoEn10am.toISOString() }],
      ahora
    );

    const slot9 = slots.find((s) => partesEnZona(s.inicio).hour === 9);
    const slot11 = slots.find((s) => partesEnZona(s.inicio).hour === 11);
    expect(slot9?.disponible).toBe(true);
    expect(slot11?.disponible).toBe(true);
  });

  it('devuelve [] si el recurso no opera ese día', () => {
    const recurso = makeRecurso({
      horarios: [{ dia: 'lunes', inicio: '09:00', fin: '18:00' }]
    });
    const fecha = '2026-05-12'; // martes
    const slots = generarSlotsDisponibles(recurso, fecha, baseConfig, [], [], instanteEnZona(2026, 4, 10));
    expect(slots).toEqual([]);
  });
});

describe('generarFechasReservables', () => {
  it('genera anticipacion_max_dias fechas desde hoy', () => {
    const ahora = instanteEnZona(2026, 4, 14, 12, 0);
    const fechas = generarFechasReservables(baseConfig, ahora);
    expect(fechas).toHaveLength(30);
    expect(fechas[0].label).toBe('Hoy');
    expect(fechas[1].label).toBe('Mañana');
  });
});

describe('filtrarRecursosPorTier', () => {
  it('básica no ve recurso Pro-only', () => {
    const black = makeRecurso({ slug: 'black', tiers_permitidos: ['pro'] });
    const e1 = makeRecurso({ slug: 'estudio-1', tiers_permitidos: ['basica', 'pro'] });
    const filtrados = filtrarRecursosPorTier([black, e1], 'basica');
    expect(filtrados).toHaveLength(1);
    expect(filtrados[0].slug).toBe('estudio-1');
  });

  it('pro ve todos', () => {
    const black = makeRecurso({ slug: 'black', tiers_permitidos: ['pro'] });
    const e1 = makeRecurso({ slug: 'estudio-1', tiers_permitidos: ['basica', 'pro'] });
    const filtrados = filtrarRecursosPorTier([black, e1], 'pro');
    expect(filtrados).toHaveLength(2);
  });
});

describe('puedeReservarRecurso (gate Pro: Esencial fuera, Premium/paquete dentro)', () => {
  const proStudio = { tiers_permitidos: ['premium', 'sesion-suelta', 'creador'] };
  const estandar = { tiers_permitidos: ['esencial', 'premium', 'sesion-suelta', 'creador'] };

  it('Esencial NO puede reservar un estudio Pro', () => {
    expect(puedeReservarRecurso(proStudio, 'esencial')).toBe(false);
  });
  it('Premium SÍ puede reservar un estudio Pro', () => {
    expect(puedeReservarRecurso(proStudio, 'premium')).toBe(true);
  });
  it('un paquete de créditos SÍ puede reservar un estudio Pro', () => {
    expect(puedeReservarRecurso(proStudio, 'creador')).toBe(true);
  });
  it('Esencial SÍ puede reservar un estudio estándar', () => {
    expect(puedeReservarRecurso(estandar, 'esencial')).toBe(true);
  });
  it('sin plan no puede reservar un estudio con tiers definidos', () => {
    expect(puedeReservarRecurso(estandar, null)).toBe(false);
  });
});

describe('traducirErrorRPC', () => {
  it('EKKO_LIMITE_DIARIO → mensaje de tope diario alcanzado', () => {
    expect(traducirErrorRPC('EKKO_LIMITE_DIARIO: Ya tienes el máximo de 1 sesión por día'))
      .toBe('Alcanzaste el máximo de sesiones que puedes reservar ese día. Elige otro día.');
  });
  it('EKKO_TIER_NO_PERMITIDO → mensaje de plan sin acceso', () => {
    expect(traducirErrorRPC('EKKO_TIER_NO_PERMITIDO: ...')).toBe('Tu plan no tiene acceso a este estudio.');
  });
});

describe('utilidades de fecha', () => {
  it('diaNombre devuelve nombre en español', () => {
    const lunes = instanteEnZona(2026, 4, 11, 12); // mediodía de pared del estudio
    expect(diaNombre(lunes)).toBe('lunes');
  });

  it('formatDateISO produce YYYY-MM-DD en la zona del estudio', () => {
    const d = instanteEnZona(2026, 4, 14, 23, 30);
    expect(formatDateISO(d)).toBe('2026-05-14');
  });

  it('lista vacía = estudio abierto: entra con cualquier plan y también sin plan (regla de la base)', () => {
    const abierto = { tiers_permitidos: [] as string[] };
    expect(puedeReservarRecurso(abierto, 'esencial')).toBe(true);
    expect(puedeReservarRecurso(abierto, 'premium')).toBe(true);
    expect(puedeReservarRecurso(abierto, null)).toBe(true);
  });
});

describe('generarSlotsDisponibles · permitirEnCurso (recepción, walk-in tarde)', () => {
  it('sin la opción, un slot que ya empezó es "pasado"; con la opción sigue disponible hasta que termina', () => {
    const recurso = makeRecurso();
    const fecha = '2026-05-11'; // lunes, bloque 09:00–12:00
    const ahora = instanteEnZona(2026, 4, 11, 9, 20); // 9:20: el slot de 9 ya empezó
    const sinOpcion = generarSlotsDisponibles(recurso, fecha, { ...baseConfig, anticipacion_min_horas: 0 }, [], [], ahora);
    expect(sinOpcion[0].razon).toBe('pasado');
    const conOpcion = generarSlotsDisponibles(recurso, fecha, { ...baseConfig, anticipacion_min_horas: 0 }, [], [], ahora, { permitirEnCurso: true });
    expect(conOpcion[0].disponible).toBe(true);
    // Uno que ya TERMINÓ sigue sin estar disponible.
    const masTarde = instanteEnZona(2026, 4, 11, 10, 5);
    const tarde = generarSlotsDisponibles(recurso, fecha, { ...baseConfig, anticipacion_min_horas: 0 }, [], [], masTarde, { permitirEnCurso: true });
    expect(tarde[0].razon).toBe('pasado');
    expect(tarde[1].disponible).toBe(true);
  });
});
