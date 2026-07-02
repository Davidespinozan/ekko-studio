import { describe, it, expect } from 'vitest';
import { resumenCarnet } from '../carnetMembresia';

const AHORA = new Date('2026-07-01T12:00:00Z');
const FUTURO = '2026-07-20T00:00:00Z';
const PASADO = '2026-06-10T00:00:00Z';

describe('resumenCarnet', () => {
  it('pendiente_pago → requiere acción y badge Pendiente', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'pendiente_pago', creditosRestantes: null, periodoActualFin: null, ahora: AHORA });
    expect(r.estadoLabel).toBe('Pendiente');
    expect(r.estadoTono).toBe('warning');
    expect(r.requiereAccion).toBe(true);
  });

  it('suspendida → danger y requiere acción', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'suspendida', creditosRestantes: null, periodoActualFin: FUTURO, ahora: AHORA });
    expect(r.estadoLabel).toBe('Suspendida');
    expect(r.estadoTono).toBe('danger');
    expect(r.requiereAccion).toBe(true);
  });

  it('sin status → "Sin plan", neutral, requiere acción', () => {
    const r = resumenCarnet({ tipo: null, status: null, creditosRestantes: null, periodoActualFin: null, ahora: AHORA });
    expect(r.estadoLabel).toBe('Sin plan');
    expect(r.estadoTono).toBe('neutral');
    expect(r.requiereAccion).toBe(true);
  });

  it('cancelada → tratada como sin plan', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'cancelada', creditosRestantes: null, periodoActualFin: FUTURO, ahora: AHORA });
    expect(r.estadoLabel).toBe('Sin plan');
    expect(r.requiereAccion).toBe(true);
  });

  it('activa por tiempo con periodo vigente → muestra renovación', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'activa', creditosRestantes: null, periodoActualFin: FUTURO, ahora: AHORA });
    expect(r.estadoTono).toBe('success');
    expect(r.requiereAccion).toBe(false);
    expect(r.subtitulo).toContain('Renueva');
  });

  it('activa por tiempo pero periodo vencido → "Vencida"', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'activa', creditosRestantes: null, periodoActualFin: PASADO, ahora: AHORA });
    expect(r.estadoLabel).toBe('Vencida');
    expect(r.requiereAccion).toBe(true);
  });

  it('plan por créditos con saldo → cuenta créditos, activa', () => {
    const r = resumenCarnet({ tipo: 'creditos', status: 'activa', creditosRestantes: 8, periodoActualFin: null, ahora: AHORA });
    expect(r.titulo).toContain('8 créditos');
    expect(r.requiereAccion).toBe(false);
  });

  it('plan por créditos agotado → "Sin créditos" y requiere acción', () => {
    const r = resumenCarnet({ tipo: 'creditos', status: 'activa', creditosRestantes: 0, periodoActualFin: null, ahora: AHORA });
    expect(r.estadoLabel).toBe('Sin créditos');
    expect(r.requiereAccion).toBe(true);
  });

  it('1 crédito → singular', () => {
    const r = resumenCarnet({ tipo: 'creditos', status: 'activa', creditosRestantes: 1, periodoActualFin: null, ahora: AHORA });
    expect(r.titulo).toBe('1 crédito disponible');
    expect(r.subtitulo).toContain('pocos');
  });

  it('híbrido activo → créditos + renovación', () => {
    const r = resumenCarnet({ tipo: 'hibrido', status: 'activa', creditosRestantes: 4, periodoActualFin: FUTURO, ahora: AHORA });
    expect(r.titulo).toContain('4 créditos');
    expect(r.subtitulo).toContain('Renueva');
    expect(r.requiereAccion).toBe(false);
  });

  it('acepta status "active" (inglés) como activa', () => {
    const r = resumenCarnet({ tipo: 'tiempo', status: 'active', creditosRestantes: null, periodoActualFin: FUTURO, ahora: AHORA });
    expect(r.estadoTono).toBe('success');
  });
});
