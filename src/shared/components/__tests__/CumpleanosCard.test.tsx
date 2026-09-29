import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/** PKG-02A (C02 · F23) — la tarjeta de cumpleaños: error ≠ "nadie cumple años" (antes se ocultaba). */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown }, llamadas: 0 }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: () => { h.llamadas++; return Promise.resolve(h.resultado); } }
}));

import { CumpleanosCard } from '../CumpleanosCard';

describe('CumpleanosCard (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → no se muestra nada (vacío real, la tarjeta se oculta)', async () => {
    render(<CumpleanosCard />);
    await waitFor(() => expect(h.llamadas).toBe(1));
    expect(screen.queryByTestId('cumpleanos-card')).not.toBeInTheDocument();
  });

  it('success con datos → lista', async () => {
    h.resultado = { data: [{ usuario_id: 'u1', nombre: 'Ana', en_dias: 0 }], error: null };
    render(<CumpleanosCard />);
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Hoy')).toBeInTheDocument();
  });

  it('error → tarjeta con "No pudimos cargar los cumpleaños." + Reintentar (no se oculta como si no hubiera nadie)', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    render(<CumpleanosCard />);
    expect(await screen.findByText('No pudimos cargar los cumpleaños.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    h.resultado = { data: [{ usuario_id: 'u1', nombre: 'Ana', en_dias: 2 }], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Ana')).toBeInTheDocument();
  });
});
