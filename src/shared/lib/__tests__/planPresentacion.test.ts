import { describe, it, expect } from 'vitest';
import { esPlanPaquete, sufijoPrecio, detallePlan } from '../planPresentacion';

describe('planPresentacion', () => {
  it('mensual (tiempo) → no es paquete, sufijo /mes', () => {
    const t = { precio_centavos: 80000, tipo: 'tiempo' };
    expect(esPlanPaquete(t)).toBe(false);
    expect(sufijoPrecio(t)).toBe('/mes');
    expect(detallePlan({ ...t })).toBe('Acceso mensual ilimitado');
  });

  it('créditos → paquete, sufijo pago único, N sesiones sin vencimiento', () => {
    const t = { precio_centavos: 120000, tipo: 'creditos', clases_incluidas: 10 };
    expect(esPlanPaquete(t)).toBe(true);
    expect(sufijoPrecio(t)).toBe(' · pago único');
    expect(detallePlan(t)).toBe('10 sesiones · sin vencimiento');
  });

  it('híbrido → paquete con vencimiento en días', () => {
    const t = { precio_centavos: 100000, tipo: 'hibrido', clases_incluidas: 1, duracion_dias: 30 };
    expect(esPlanPaquete(t)).toBe(true);
    expect(detallePlan(t)).toBe('1 sesión · vencen en 30 días');
  });

  it('tipo ausente → se trata como mensual', () => {
    expect(esPlanPaquete({ tipo: null })).toBe(false);
    expect(sufijoPrecio({})).toBe('/mes');
  });
});
