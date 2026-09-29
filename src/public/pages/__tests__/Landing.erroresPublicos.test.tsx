import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-02A (C02 · F20) — Landing pública: si fallan estudios o planes NO se
 * muestra una landing "vacía" en silencio; aviso discreto + Reintentar, sin
 * tecnicismos, y el resto de la página sigue renderizando.
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data: unknown; error: unknown }>,
  llamadas: {} as Record<string, number>
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => {
        h.llamadas[tabla] = (h.llamadas[tabla] ?? 0) + 1;
        return Promise.resolve(h.porTabla[tabla] ?? { data: [], error: null });
      };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', nombre: 'EKKO Studio', slug: 'ekko', config: {}, branding: {} }) }));
vi.mock('../../components/EstudioModal', () => ({ default: () => null }));
vi.mock('../../components/AppShowcase', () => ({ default: () => null }));
vi.mock('../../components/Footer', () => ({ default: () => null }));
vi.mock('../../components/Reveal', () => ({ Reveal: (p: { children: React.ReactNode }) => <>{p.children}</> }));

import Landing from '../Landing';

const ESTUDIO = { id: 'r1', slug: 'black', nombre: 'Set Black', descripcion: null, tiers_permitidos: [], costo_creditos: 1, tipo_contenido: [], equipo_incluido: [], estilo_visual: null, capacidad_personas: 2, foto_url: null };
const TIER = { slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, descripcion: null, beneficios: [], reglas: {}, tipo: 'tiempo', clases_incluidas: null, orden: 1 };
const montar = () => render(<MemoryRouter><Landing /></MemoryRouter>);

describe('Landing · errores públicos (PKG-02A)', () => {
  beforeEach(() => {
    h.porTabla = { recursos: { data: [ESTUDIO], error: null }, tiers: { data: [TIER], error: null } };
    h.llamadas = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → estudios y planes visibles, sin avisos', async () => {
    montar();
    expect(await screen.findByText('Set Black')).toBeInTheDocument();
    expect(await screen.findByText('ESENCIAL')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fallan los planes → aviso discreto + Reintentar, los estudios siguen; sin error técnico', async () => {
    h.porTabla.tiers = { data: null, error: { message: 'permission denied for table tiers' } };
    montar();
    expect(await screen.findByText('No pudimos cargar los planes en este momento.')).toBeInTheDocument();
    expect(await screen.findByText('Set Black')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied|PGRST|tiers/i);
    h.porTabla.tiers = { data: [TIER], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas.tiers).toBe(2));
    expect(await screen.findByText('ESENCIAL')).toBeInTheDocument();
  });

  it('fallan los estudios → aviso discreto; los planes siguen', async () => {
    h.porTabla.recursos = { data: null, error: { message: 'timeout' } };
    montar();
    expect(await screen.findByText('No pudimos cargar los estudios en este momento.')).toBeInTheDocument();
    expect(await screen.findByText('ESENCIAL')).toBeInTheDocument();
    expect(screen.queryByText('Set Black')).not.toBeInTheDocument();
  });
});
