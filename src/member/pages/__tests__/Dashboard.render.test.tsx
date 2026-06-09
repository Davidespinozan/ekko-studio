import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Render del Dashboard del member: las tarjetas de estudio deben mostrar
 * la imagen real (`foto_url`) cuando existe, y caer al placeholder
 * "FOTO PRÓXIMAMENTE" sólo cuando no hay foto.
 *
 * Mock por tabla: `recursos` devuelve estudios; `reservas` devuelve [].
 */

const h = vi.hoisted(() => ({
  recursos: [] as unknown[]
}));

vi.mock('@shared/lib/supabase', () => {
  function makeBuilder(table: string) {
    const result = table === 'recursos'
      ? { data: h.recursos, error: null }
      : { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
      builder[m] = () => builder;
    }
    builder.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
    return builder;
  }
  return { supabase: { from: (table: string) => makeBuilder(table) } };
});

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ usuario: { id: 'u-1', nombre: 'Ana', bloqueado_hasta: null } })
}));

vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => ({ id: 't-1', config: {} })
}));

vi.mock('@shared/hooks/useToast', () => ({
  useToast: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() })
}));

import Dashboard from '../Dashboard';

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

beforeEach(() => {
  h.recursos = [];
});

describe('Dashboard · imágenes de estudios', () => {
  it('renderiza la <img> con foto_url cuando el estudio tiene foto', async () => {
    h.recursos = [
      { id: 'r-1', slug: 'estudio-1', nombre: 'Estudio 1', descripcion: null,
        foto_url: 'https://cdn.test/estudio-1.jpg', tiers_permitidos: ['basica'], activo: true }
    ];
    renderDashboard();
    const img = await screen.findByAltText('Estudio 1');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toBe('https://cdn.test/estudio-1.jpg');
  });

  it('muestra el placeholder cuando el estudio no tiene foto', async () => {
    h.recursos = [
      { id: 'r-2', slug: 'estudio-2', nombre: 'Estudio 2', descripcion: null,
        foto_url: null, tiers_permitidos: ['basica'], activo: true }
    ];
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Estudio 2')).toBeInTheDocument());
    expect(screen.getByText('FOTO PRÓXIMAMENTE')).toBeInTheDocument();
    expect(screen.queryByAltText('Estudio 2')).not.toBeInTheDocument();
  });
});
