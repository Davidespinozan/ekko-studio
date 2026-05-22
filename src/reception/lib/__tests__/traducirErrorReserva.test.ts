import { describe, it, expect } from 'vitest';
import { traducirErrorReserva } from '../traducirErrorReserva';

describe('traducirErrorReserva', () => {
  it('códigos nuevos de RP-1', () => {
    expect(traducirErrorReserva('EKKO_MIEMBRO_NO_ACTIVO: x')).toMatch(/no está activo/i);
    expect(traducirErrorReserva('EKKO_MIEMBRO_INVALIDO: x')).toMatch(/no válido/i);
    expect(traducirErrorReserva('EKKO_MIEMBRO_BLOQUEADO: x')).toMatch(/restricción/i);
    expect(traducirErrorReserva('EKKO_NO_AUTORIZADO: x')).toMatch(/permiso/i);
  });

  it('delega los códigos compartidos a traducirErrorRPC', () => {
    expect(traducirErrorReserva('EKKO_SLOT_OCUPADO: x')).toMatch(/horario/i);
    expect(traducirErrorReserva('EKKO_RESERVA_NO_CANCELABLE: x')).toMatch(/no se puede cancelar/i);
    expect(traducirErrorReserva('EKKO_RESERVA_PASADA: x')).toMatch(/ya pasó/i);
  });

  it('fallback genérico — nunca expone el mensaje técnico crudo', () => {
    const crudo = 'PGRST301: jwt expired at column 9';
    const out = traducirErrorReserva(crudo);
    // Delega en traducirErrorRPC, cuyo fallback genérico (ERROR-UI-FIX E-04)
    // es "...la operación...". Lo importante: NUNCA el crudo.
    expect(out).toBe('No se pudo completar la operación. Intentá de nuevo.');
    expect(out).not.toContain('jwt');
    expect(out).not.toContain('PGRST');
  });
});
