import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ membresia: null as unknown, isLoading: false }));

vi.mock('@shared/hooks/useMembresiaVigente', () => ({
  useMembresiaVigente: () => ({ membresia: h.membresia, isLoading: h.isLoading, refetch: vi.fn() })
}));

import { VigenciaMembresia } from '../VigenciaMembresia';

const DIA = 24 * 60 * 60 * 1000;

describe('VigenciaMembresia', () => {
  beforeEach(() => {
    h.membresia = null;
    h.isLoading = false;
  });

  it('sin membresía viva → SIN MEMBRESÍA', () => {
    render(<VigenciaMembresia usuarioId="u1" />);
    expect(screen.getByText('SIN MEMBRESÍA')).toBeInTheDocument();
  });

  it('mensual vigente → VIGENTE + "vence <fecha>"', () => {
    h.membresia = {
      id: 'm1', status: 'activa', periodo_actual_fin: new Date(Date.now() + 20 * DIA).toISOString(),
      creditos_restantes: null, stripe_subscription_id: 'sub', cancel_at_period_end: false, created_at: '', tier: { slug: 'esencial', nombre: 'Esencial', tipo: 'tiempo' }
    };
    render(<VigenciaMembresia usuarioId="u1" variante="linea" />);
    expect(screen.getByText('VIGENTE')).toBeInTheDocument();
    expect(screen.getByText(/^vence /)).toBeInTheDocument();
  });

  it('paquete → créditos restantes; vencida por fecha aunque status diga activa', () => {
    h.membresia = {
      id: 'm1', status: 'activa', periodo_actual_fin: new Date(Date.now() - 2 * DIA).toISOString(),
      creditos_restantes: 2, stripe_subscription_id: null, cancel_at_period_end: null, created_at: '', tier: { slug: 'creador', nombre: 'Creador', tipo: 'hibrido' }
    };
    render(<VigenciaMembresia usuarioId="u1" />);
    expect(screen.getByText('VENCIDA')).toBeInTheDocument();
    expect(screen.getByText(/2 créditos · caducan/)).toBeInTheDocument();
  });
});
