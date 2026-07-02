import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Inicio del member: muestra el carnet de membresía compacto (plan + estado +
 * actividad) y NO duplica el grid de estudios ni los accesos rápidos (esos ya
 * están en el menú inferior). Este test fija ese contrato.
 */

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) builder[m] = () => builder;
  builder.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb);
  return { supabase: { from: () => builder } };
});

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ usuario: { id: 'u-1', nombre: 'Ana', bloqueado_hasta: null } })
}));

vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => ({ id: 't-1', nombre: 'EKKO' })
}));

import Dashboard from '../Dashboard';

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

describe('Dashboard · inicio del member', () => {
  it('muestra el carnet de membresía y NO los accesos rápidos (viven en el menú)', async () => {
    renderDashboard();
    expect(await screen.findByText('Membresía')).toBeInTheDocument();
    expect(screen.queryByText('Reservar sesión')).not.toBeInTheDocument();
    expect(screen.queryByText('Ver estudios')).not.toBeInTheDocument();
  });

  it('ya no renderiza el grid de estudios en el inicio', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Membresía')).toBeInTheDocument());
    expect(screen.queryByText('FOTO PRÓXIMAMENTE')).not.toBeInTheDocument();
    expect(screen.queryByText('DISPONIBLE')).not.toBeInTheDocument();
  });
});
