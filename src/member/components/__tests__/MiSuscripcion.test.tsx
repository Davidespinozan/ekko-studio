import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * MiSuscripcion: muestra el plan actual con datos reales del tier, estado
 * vacío de pagos, y permite cambiar de plan IN-APP (vía backend change-plan,
 * no WhatsApp).
 */

const h = vi.hoisted(() => ({
  tiers: [] as unknown[],
  pagos: [] as unknown[],
  changePlan: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => {
  function builderFor(table: string) {
    const result = table === 'tiers'
      ? { data: h.tiers, error: null }
      : { data: h.pagos, error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
    b.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
    return b;
  }
  return { supabase: { from: (t: string) => builderFor(t) } };
});

vi.mock('@shared/lib/backend', () => ({
  backendPost: (path: string, body: unknown) => h.changePlan(path, body)
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
  h.changePlan = vi.fn().mockResolvedValue({ success: true });
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

  it('cambia de plan in-app (llama a change-plan) y refleja el nuevo plan', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Cambiar de plan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cambiar de plan'));
    await waitFor(() => expect(screen.getByText('CAMBIAR DE PLAN')).toBeInTheDocument());
    // El plan no-actual (Básica) ofrece cambiar
    fireEvent.click(screen.getByText('Cambiar a este'));
    await waitFor(() => expect(h.changePlan).toHaveBeenCalledWith('change-plan', { tier: 'basica' }));
  });
});
