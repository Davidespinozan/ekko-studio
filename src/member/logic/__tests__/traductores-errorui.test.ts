import { describe, it, expect } from 'vitest';
import { traducirErrorRPC } from '../reservaLogic';
import { traducirErrorQR } from '@member/pages/MiQR';

/**
 * ERROR-UI-FIX E-04 / E-05 — los traductores del miembro nunca devuelven el
 * mensaje crudo de Postgres/Supabase/HTTP: su fallback es un genérico human.
 */

describe('traducirErrorRPC · E-04', () => {
  it('código/error desconocido → genérico, NO el crudo', () => {
    const crudo = 'duplicate key value violates unique constraint "reservas_pkey"';
    const out = traducirErrorRPC(crudo);
    expect(out).toBe('No se pudo completar la operación. Intentá de nuevo.');
    expect(out).not.toContain('constraint');
  });

  it('un error de red crudo tampoco se filtra', () => {
    expect(traducirErrorRPC('TypeError: Failed to fetch')).toBe(
      'No se pudo completar la operación. Intentá de nuevo.'
    );
  });

  it('EKKO_NO_AUTH → mensaje de sesión', () => {
    expect(traducirErrorRPC('EKKO_NO_AUTH: Usuario no autenticado')).toBe(
      'Tu sesión expiró. Iniciá sesión de nuevo.'
    );
  });

  it('EKKO_NO_AUTORIZADO conserva su mensaje (no lo pisa EKKO_NO_AUTH)', () => {
    // 'EKKO_NO_AUTH' es substring de 'EKKO_NO_AUTORIZADO' — el orden importa.
    expect(traducirErrorRPC('EKKO_NO_AUTORIZADO: No podés')).toBe(
      'No puedes hacer esta acción.'
    );
  });

  it('EKKO_FUERA_DE_HORARIO → mensaje de horario (código que faltaba)', () => {
    expect(traducirErrorRPC('EKKO_FUERA_DE_HORARIO: x')).toBe(
      'Ese horario está fuera del horario del estudio.'
    );
  });

  it('un código previo sigue traduciéndose', () => {
    expect(traducirErrorRPC('EKKO_SLOT_OCUPADO')).toContain('tomado');
  });
});

describe('traducirErrorQR · E-05', () => {
  it('código desconocido / HTTP crudo → genérico, NO el crudo', () => {
    const out = traducirErrorQR('HTTP 500');
    expect(out).toBe('No se pudo generar tu código QR. Intentá de nuevo.');
    expect(out).not.toContain('HTTP');
  });

  it('un caso de dominio conocido sigue traduciéndose', () => {
    expect(traducirErrorQR('La reserva fue cancelada')).toContain('cancelada');
  });
});
