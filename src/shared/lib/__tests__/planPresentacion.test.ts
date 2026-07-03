import { describe, it, expect } from 'vitest';
import { esPlanPaquete, sufijoPrecio, detallePlan, sufijoPrecioSesiones, esTierRecomendado } from '../planPresentacion';

describe('planPresentacion', () => {
  it('mensual (tiempo) → no es paquete, sufijo /mes', () => {
    const t = { precio_centavos: 80000, tipo: 'tiempo' };
    expect(esPlanPaquete(t)).toBe(false);
    expect(sufijoPrecio(t)).toBe('/mes');
    expect(detallePlan({ ...t })).toBe('Acceso mensual · graba todos los días');
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

  describe('sufijoPrecioSesiones (landing)', () => {
    it('mensual → /mes', () => {
      expect(sufijoPrecioSesiones({ tipo: 'tiempo' })).toBe('/mes');
    });
    it('paquete de 1 → singular "sesión"', () => {
      expect(sufijoPrecioSesiones({ tipo: 'hibrido', clases_incluidas: 1 })).toBe(' · 1 sesión');
    });
    it('paquete de N → plural "sesiones"', () => {
      expect(sufijoPrecioSesiones({ tipo: 'creditos', clases_incluidas: 6 })).toBe(' · 6 sesiones');
    });
    it('paquete sin cupo definido → " · paquete"', () => {
      expect(sufijoPrecioSesiones({ tipo: 'creditos', clases_incluidas: null })).toBe(' · paquete');
    });
  });

  describe('esTierRecomendado', () => {
    it('reglas.recomendado true → destacado', () => {
      expect(esTierRecomendado({ recomendado: true })).toBe(true);
    });
    it('flag ausente, falso, o reglas null → no destacado', () => {
      expect(esTierRecomendado({ recomendado: false })).toBe(false);
      expect(esTierRecomendado({ max_invitados: 2 })).toBe(false);
      expect(esTierRecomendado(null)).toBe(false);
      expect(esTierRecomendado(undefined)).toBe(false);
    });
  });
});
