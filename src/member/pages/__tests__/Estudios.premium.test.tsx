import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** Pulido premium · /app/estudios: tarjeta con foto, nombre, datos cortos, PRO y enlace al detalle. */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown } }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => Promise.resolve(h.resultado);
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import Estudios from '../Estudios';

const base = { descripcion: null, activo: true, tiers_permitidos: [] };

beforeEach(() => {
  h.resultado = { data: [], error: null };
});

describe('Estudios · tarjetas premium', () => {
  it('nombre, capacidad y tipo en la tarjeta; PRO solo si cuesta 2 créditos o más; enlace al detalle', async () => {
    h.resultado = {
      data: [
        { ...base, id: 'r1', slug: 'black', nombre: 'Set Black', foto_url: 'https://x/black.jpg', costo_creditos: 2, capacidad_personas: 4, tipo_contenido: ['Podcast', 'Entrevistas'] },
        { ...base, id: 'r2', slug: 'mini', nombre: 'Mini', foto_url: null, costo_creditos: 1, capacidad_personas: 1, tipo_contenido: [] }
      ],
      error: null
    };
    render(<MemoryRouter><Estudios /></MemoryRouter>);
    expect(await screen.findByText('Set Black')).toBeInTheDocument();
    expect(screen.getByText('Nuestros espacios · 2 estudios')).toBeInTheDocument();
    expect(screen.getByText('Hasta 4 personas · Podcast')).toBeInTheDocument();
    expect(screen.getByText('Hasta 1 persona')).toBeInTheDocument();
    expect(screen.getAllByText('PRO')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Set Black: ver detalle' })).toHaveAttribute('href', '/app/estudios/black');
    expect(screen.getByText('Foto próximamente')).toBeInTheDocument();
  });
});
