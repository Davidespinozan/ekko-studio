import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MembresiaActualCard, estadoMembresia } from '../MembresiaActualCard';

const AHORA = new Date('2026-08-21T18:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;

describe('estadoMembresia (derivado por fecha, no solo por status)', () => {
  it('sin membresía', () => {
    expect(estadoMembresia(null, AHORA)).toBe('sin_membresia');
  });
  it('activa con fin futuro → vigente; a <3 días → por_vencer; fin pasado → vencida aunque status diga activa', () => {
    expect(estadoMembresia({ status: 'activa', periodo_actual_fin: new Date(AHORA.getTime() + 20 * DIA).toISOString() }, AHORA)).toBe('vigente');
    expect(estadoMembresia({ status: 'activa', periodo_actual_fin: new Date(AHORA.getTime() + 2 * DIA).toISOString() }, AHORA)).toBe('por_vencer');
    expect(estadoMembresia({ status: 'activa', periodo_actual_fin: new Date(AHORA.getTime() - 1 * DIA).toISOString() }, AHORA)).toBe('vencida');
  });
  it('past_due → pago_pendiente; sin fecha (paquete sin vencer) → vigente', () => {
    expect(estadoMembresia({ status: 'past_due', periodo_actual_fin: null }, AHORA)).toBe('pago_pendiente');
    expect(estadoMembresia({ status: 'activa', periodo_actual_fin: null }, AHORA)).toBe('vigente');
  });
});

describe('MembresiaActualCard', () => {
  it('avisa cuando el plan asignado no coincide con la membresía vigente', () => {
    render(
      <MembresiaActualCard
        isLoading={false}
        planAsignado="premium"
        membresia={{
          id: 'm1', status: 'activa', periodo_actual_fin: new Date(AHORA.getTime() + 20 * DIA).toISOString(),
          creditos_restantes: null, stripe_subscription_id: 'sub_1', cancel_at_period_end: false,
          created_at: AHORA.toISOString(), tier: { slug: 'esencial', nombre: 'Esencial', tipo: 'tiempo' }
        }}
      />
    );
    expect(screen.getByText('Esencial')).toBeInTheDocument();
    expect(screen.getByText(/Plan asignado distinto \(premium\)/)).toBeInTheDocument();
    expect(screen.getByText(/^Stripe/)).toBeInTheDocument();
  });

  it('paquete de créditos muestra créditos y cobro manual', () => {
    render(
      <MembresiaActualCard
        isLoading={false}
        planAsignado="creador"
        membresia={{
          id: 'm1', status: 'activa', periodo_actual_fin: null, creditos_restantes: 3,
          stripe_subscription_id: null, cancel_at_period_end: null, created_at: AHORA.toISOString(),
          tier: { slug: 'creador', nombre: 'Creador', tipo: 'creditos' }
        }}
      />
    );
    expect(screen.getByText('Créditos restantes')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Manual / mostrador')).toBeInTheDocument();
  });

  it('sin membresía pero con plan asignado → lo dice', () => {
    render(<MembresiaActualCard isLoading={false} planAsignado="esencial" membresia={null} />);
    expect(screen.getByText('SIN MEMBRESÍA')).toBeInTheDocument();
    expect(screen.getByText(/sin activar todavía/)).toBeInTheDocument();
  });
});
