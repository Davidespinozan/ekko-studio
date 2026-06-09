import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * MiSuscripcion: muestra el plan actual con datos reales del tier, estado
 * vacío de pagos cuando no hay historial, y abre el modal de cambio de plan.
 */

const h = vi.hoisted(() => ({
  tiers: [] as unknown[],
  pagos: [] as unknown[]
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

vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => ({ id: 't-1', config: { contacto: { whatsapp_e164: '+521112223333' } } })
}));

import { MiSuscripcion } from '../MiSuscripcion';

beforeEach(() => {
  h.tiers = [
    { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: ['Acceso diario'], descripcion: null },
    { slug: 'pro', nombre: 'Pro', precio_centavos: 120000, beneficios: ['Todo Básica', 'Estudios pro'], descripcion: null }
  ];
  h.pagos = [];
});

function renderComp(tierSlug: string | null = 'pro') {
  return render(
    <MiSuscripcion usuarioId="u-1" tierSlug={tierSlug} status="activa" nombre="Ana" />
  );
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

  it('abre el modal de cambio de plan y lista los otros planes', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Cambiar de plan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cambiar de plan'));
    await waitFor(() => expect(screen.getByText('CAMBIAR DE PLAN')).toBeInTheDocument());
    // el plan no-actual (Básica) ofrece solicitar
    expect(screen.getByText('Solicitar')).toBeInTheDocument();
  });
});
