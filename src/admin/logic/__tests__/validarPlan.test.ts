import { describe, it, expect } from 'vitest';
import { validarPlan, type PlanDraft } from '../validarPlan';

const paquete: PlanDraft = {
  nombre: 'Pro-pack',
  precioCentavos: 199000,
  esPaquete: true,
  vence: true,
  clasesIncluidas: 12,
  duracionDias: 120
};

describe('validarPlan', () => {
  it('un paquete bien formado es válido', () => {
    expect(validarPlan(paquete)).toBeNull();
  });

  it('vigencia de 0 días (lo que producía `parseInt("") || 0`): rechazada', () => {
    expect(validarPlan({ ...paquete, duracionDias: 0 })).toMatch(/al menos 1 día/);
  });

  it('vigencia NaN o fraccionaria: rechazada', () => {
    expect(validarPlan({ ...paquete, duracionDias: NaN })).toMatch(/al menos 1 día/);
    expect(validarPlan({ ...paquete, duracionDias: 1.5 })).toMatch(/al menos 1 día/);
  });

  it('paquete que NO vence: la vigencia no se valida (se guarda como NULL)', () => {
    expect(validarPlan({ ...paquete, vence: false, duracionDias: 0 })).toBeNull();
  });

  it('paquete con 0 sesiones: rechazado', () => {
    expect(validarPlan({ ...paquete, clasesIncluidas: 0 })).toMatch(/al menos 1 sesión/);
  });

  it('membresía por tiempo: no mira sesiones ni vigencia', () => {
    expect(
      validarPlan({ ...paquete, esPaquete: false, vence: false, clasesIncluidas: 0, duracionDias: 0 })
    ).toBeNull();
  });

  it('nombre vacío: rechazado también al EDITAR (antes solo se validaba al crear)', () => {
    expect(validarPlan({ ...paquete, nombre: '   ' })).toMatch(/nombre/);
  });

  it('precio negativo o NaN: rechazado; $0 permitido (cortesía)', () => {
    expect(validarPlan({ ...paquete, precioCentavos: -1 })).toMatch(/Precio/);
    expect(validarPlan({ ...paquete, precioCentavos: NaN })).toMatch(/Precio/);
    expect(validarPlan({ ...paquete, precioCentavos: 0 })).toBeNull();
  });
});
