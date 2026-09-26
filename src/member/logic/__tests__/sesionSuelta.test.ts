import { describe, it, expect } from 'vitest';
import { elegirPaquetePorHora, type PlanCandidato } from '../sesionSuelta';

const t = (o: Partial<PlanCandidato> & { slug: string }): PlanCandidato => ({
  nombre: o.slug, precio_centavos: 10000, tipo: 'hibrido', clases_incluidas: 1, activo: true, en_venta: true, ...o
});
const suelta = t({ slug: 'sesion-suelta', precio_centavos: 25000, clases_incluidas: 1 });
const creador = t({ slug: 'creador', precio_centavos: 115000, clases_incluidas: 6 });
const esencial = t({ slug: 'esencial', tipo: 'tiempo', clases_incluidas: null, precio_centavos: 85000 });

describe('elegirPaquetePorHora', () => {
  it('estudio de 1 crédito, sin saldo → el paquete más barato que alcance (sesión suelta)', () => {
    expect(elegirPaquetePorHora([creador, suelta, esencial], { costo_creditos: 1, tiers_permitidos: [] }, 0)?.slug).toBe('sesion-suelta');
  });

  it('estudio de 2 créditos: la sesión suelta (1) NO alcanza → el siguiente que sí', () => {
    expect(elegirPaquetePorHora([creador, suelta], { costo_creditos: 2, tiers_permitidos: [] }, 0)?.slug).toBe('creador');
  });

  it('…pero con 1 crédito de saldo, la sesión suelta sí completa los 2', () => {
    expect(elegirPaquetePorHora([creador, suelta], { costo_creditos: 2, tiers_permitidos: [] }, 1)?.slug).toBe('sesion-suelta');
  });

  it('nunca ofrece una membresía mensual ni un plan retirado/inactivo', () => {
    const retirado = t({ slug: 'viejo', precio_centavos: 100, en_venta: false });
    const inactivo = t({ slug: 'muerto', precio_centavos: 100, activo: false });
    expect(elegirPaquetePorHora([esencial, retirado, inactivo], { costo_creditos: 1, tiers_permitidos: [] }, 0)).toBeNull();
  });

  it('respeta los planes que acepta el estudio', () => {
    expect(elegirPaquetePorHora([suelta, creador], { costo_creditos: 1, tiers_permitidos: ['creador'] }, 0)?.slug).toBe('creador');
    expect(elegirPaquetePorHora([suelta], { costo_creditos: 1, tiers_permitidos: ['premium'] }, 0)).toBeNull();
  });
});
