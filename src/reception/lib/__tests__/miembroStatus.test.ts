import { describe, it, expect } from 'vitest';
import { statusMiembro } from '../miembroStatus';

describe('statusMiembro', () => {
  it('activo → sin alerta', () => {
    const r = statusMiembro('activo');
    expect(r.label).toBe('Activo');
    expect(r.alerta).toBe(false);
  });

  it('suspendido / cancelado → alerta', () => {
    expect(statusMiembro('suspendido').alerta).toBe(true);
    expect(statusMiembro('cancelado').alerta).toBe(true);
  });

  it('pendientes → alerta con copy claro', () => {
    expect(statusMiembro('pendiente_pago').label).toMatch(/pago/i);
    expect(statusMiembro('pendiente_pago').alerta).toBe(true);
    expect(statusMiembro('pendiente_onboarding').label).toMatch(/activaci/i);
    expect(statusMiembro('pendiente_onboarding').alerta).toBe(true);
  });

  it('status desconocido → alerta defensiva', () => {
    const r = statusMiembro('xyz');
    expect(r.alerta).toBe(true);
    expect(r.label).toBe('xyz');
  });
});
