import { describe, it, expect } from 'vitest';
import { accionesDeMembresia, type MembresiaParaAcciones } from '../membresiaAcciones';

const AHORA = new Date('2026-09-20T18:00:00Z');
const en = (dias: number) => new Date(AHORA.getTime() + dias * 86_400_000).toISOString();

const mensualStripe: MembresiaParaAcciones = {
  status: 'activa',
  periodo_actual_fin: en(20),
  creditos_restantes: null,
  stripe_subscription_id: 'sub_1',
  tier: { tipo: 'tiempo' }
};
const paquete: MembresiaParaAcciones = {
  status: 'activa',
  periodo_actual_fin: en(60),
  creditos_restantes: 5,
  stripe_subscription_id: null,
  tier: { tipo: 'hibrido' }
};

describe('accionesDeMembresia — la ficha decide por el estado de la MEMBRESÍA', () => {
  it('sin membresía → Asignar plan (antes: nada, si la cuenta estaba "activo")', () => {
    expect(accionesDeMembresia(null, AHORA)).toMatchObject({
      estado: 'sin_membresia',
      principal: 'asignar',
      secundarias: []
    });
  });

  it('EN PAUSA → Reanudar; nunca "Activar"/"Asignar" (creaba una segunda membresía)', () => {
    const r = accionesDeMembresia({ ...mensualStripe, status: 'pausada' }, AHORA);
    expect(r.principal).toBe('reanudar');
    expect(r.secundarias).not.toContain('asignar');
    expect(r.secundarias).not.toContain('pausar');
    expect(r.secundarias).toContain('dar_de_baja');
  });

  it('paquete SIN créditos → Renovar (el caso más común del mostrador)', () => {
    const r = accionesDeMembresia({ ...paquete, creditos_restantes: 0 }, AHORA);
    expect(r).toMatchObject({ sinCreditos: true, principal: 'renovar' });
    expect(r.secundarias).toEqual(['cambiar', 'ajustar_creditos', 'dar_de_baja']);
  });

  it('paquete vencido por fecha → Renovar, y no se ofrece pausar', () => {
    const r = accionesDeMembresia({ ...paquete, periodo_actual_fin: en(-2) }, AHORA);
    expect(r).toMatchObject({ estado: 'vencida', principal: 'renovar' });
    expect(r.secundarias).not.toContain('pausar');
  });

  it('paquete vigente → cambiar, pausar, ajustar créditos, dar de baja; sin botón principal', () => {
    expect(accionesDeMembresia(paquete, AHORA)).toMatchObject({
      estado: 'vigente',
      principal: null,
      secundarias: ['cambiar', 'pausar', 'ajustar_creditos', 'dar_de_baja']
    });
  });

  it('mensual por tiempo: no hay créditos que ajustar', () => {
    expect(accionesDeMembresia(mensualStripe, AHORA).secundarias).not.toContain('ajustar_creditos');
  });

  it('mensual de MOSTRADOR por vencer → Renovar', () => {
    const r = accionesDeMembresia({ ...mensualStripe, stripe_subscription_id: null, periodo_actual_fin: en(2) }, AHORA);
    expect(r).toMatchObject({ estado: 'por_vencer', principal: 'renovar' });
  });

  it('con suscripción STRIPE nunca se ofrece "Renovar" (se renueva sola), ni por vencer ni con la fecha pasada', () => {
    expect(accionesDeMembresia({ ...mensualStripe, periodo_actual_fin: en(2) }, AHORA).principal).toBeNull();
    const vencidaPorFecha = accionesDeMembresia({ ...mensualStripe, periodo_actual_fin: en(-1) }, AHORA);
    expect(vencidaPorFecha.principal).toBeNull();
    expect(vencidaPorFecha.secundarias).toContain('cambiar');
  });

  it('pago pendiente → se puede cambiar, pausar o dar de baja', () => {
    const r = accionesDeMembresia({ ...mensualStripe, status: 'past_due' }, AHORA);
    expect(r.estado).toBe('pago_pendiente');
    expect(r.secundarias).toEqual(['cambiar', 'pausar', 'dar_de_baja']);
  });

  it('si ya pidió la baja (no se renueva) no se vuelve a ofrecer "Dar de baja"', () => {
    const r = accionesDeMembresia({ ...mensualStripe, cancel_at_period_end: true }, AHORA);
    expect(r.secundarias).not.toContain('dar_de_baja');
  });
});
