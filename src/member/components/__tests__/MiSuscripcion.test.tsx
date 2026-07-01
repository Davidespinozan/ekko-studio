import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * MiSuscripcion: muestra el plan actual con datos reales del tier, estado
 * vacío de pagos, y permite cambiar de plan IN-APP. El cambio ahora va por
 * Stripe Checkout (función `suscribir-membresia`); sin Stripe responde
 * stripe_pendiente y la UI avisa "acercate a recepción".
 */

const h = vi.hoisted(() => ({
  tiers: [] as unknown[],
  pagos: [] as unknown[],
  membresias: [] as unknown[],
  backend: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => {
  function builderFor(table: string) {
    const result =
      table === 'tiers' ? { data: h.tiers, error: null }
      : table === 'membresias' ? { data: h.membresias, error: null }
      : { data: h.pagos, error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
    b.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
    return b;
  }
  return { supabase: { from: (t: string) => builderFor(t) } };
});

vi.mock('@shared/lib/backend', () => ({
  backendPost: (path: string, body: unknown) => h.backend(path, body)
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));
vi.mock('@shared/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}));

import { MiSuscripcion } from '../MiSuscripcion';

beforeEach(() => {
  h.tiers = [
    { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: ['Acceso diario'], descripcion: null },
    { slug: 'pro', nombre: 'Pro', precio_centavos: 120000, beneficios: ['Todo Básica', 'Estudios pro'], descripcion: null }
  ];
  h.pagos = [];
  h.membresias = [];
  // Sin Stripe configurado: el cambio de plan responde stripe_pendiente.
  h.backend = vi.fn().mockResolvedValue({ activated: false, reason: 'stripe_pendiente' });
});

function renderComp(tierSlug: string | null = 'pro') {
  return render(<MiSuscripcion usuarioId="u-1" tierSlug={tierSlug} status="activa" />);
}

describe('MiSuscripcion', () => {
  it('muestra el plan actual con nombre, precio y estado', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument());
    expect(screen.getByText('$1,200')).toBeInTheDocument();
    expect(screen.getByText('Activa')).toBeInTheDocument();
    expect(screen.getByText('Estudios pro')).toBeInTheDocument();
  });

  it('muestra estado vacío de pagos cuando no hay historial', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Sin pagos registrados')).toBeInTheDocument());
  });

  it('cambiar de plan abre el modal de pago propio', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Cambiar de plan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cambiar de plan'));
    await waitFor(() => expect(screen.getByText('CAMBIAR DE PLAN')).toBeInTheDocument());
    // Elegir el plan no-actual (Básica) abre el PaymentModal de EKKO.
    fireEvent.click(screen.getByText('Elegir este'));
    // Sin VITE_STRIPE_PUBLISHABLE_KEY en test, el modal muestra el estado pendiente.
    await waitFor(() => expect(screen.getByText('PAGO SEGURO')).toBeInTheDocument());
    expect(screen.getByText(/no están configurados/i)).toBeInTheDocument();
  });

  it('muestra el banner de pago vencido cuando la membresía está past_due', async () => {
    h.membresias = [{ status: 'past_due', stripe_subscription_id: 'sub_1', cancel_at_period_end: false, periodo_actual_fin: null }];
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Tu último pago no se procesó')).toBeInTheDocument());
    expect(screen.getByText('Gestionar suscripción')).toBeInTheDocument();
  });
});
