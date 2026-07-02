import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Inicio del member: ya NO duplica el grid de estudios (eso vive en la
 * sección Estudios). En su lugar muestra accesos rápidos. Este test fija
 * ese contrato: hay accesos rápidos y no hay grid de estudios.
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
  it('muestra accesos rápidos (Reservar / Ver estudios)', async () => {
    renderDashboard();
    const reservar = await screen.findByText('Reservar sesión');
    expect(reservar).toBeInTheDocument();
    expect(screen.getByText('Ver estudios')).toBeInTheDocument();
    // links correctos
    expect(reservar.closest('a')?.getAttribute('href')).toBe('/app/reservar');
    expect(screen.getByText('Ver estudios').closest('a')?.getAttribute('href')).toBe('/app/estudios');
  });

  it('ya no renderiza el grid de estudios en el inicio', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Reservar sesión')).toBeInTheDocument());
    expect(screen.queryByText('FOTO PRÓXIMAMENTE')).not.toBeInTheDocument();
    expect(screen.queryByText('DISPONIBLE')).not.toBeInTheDocument();
  });
});
