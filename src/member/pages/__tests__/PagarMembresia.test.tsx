import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/** PKG-02A (C02 · F17) — /app/pagar: error ≠ "No hay planes disponibles". */

const h = vi.hoisted(() => ({
  resultado: { data: [] as unknown, error: null as unknown },
  llamadas: 0,
  usuario: { id: 'u-1', nombre: 'Ana', membresia_tier: null as string | null, status: 'pendiente_pago' }
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => { h.llamadas++; return Promise.resolve(h.resultado); };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario, signOut: vi.fn() }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', nombre: 'EKKO', config: {} }) }));
vi.mock('@shared/components/PaymentModal', () => ({ PaymentModal: () => null }));

import PagarMembresia from '../PagarMembresia';

describe('PagarMembresia (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → "No hay planes disponibles…" (vacío real)', async () => {
    render(<PagarMembresia />);
    expect(await screen.findByText(/No hay planes disponibles/)).toBeInTheDocument();
  });

  it('success con planes → muestra el plan', async () => {
    h.resultado = { data: [{ slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, tipo: 'tiempo', clases_incluidas: null, duracion_dias: 30, beneficios: [] }], error: null };
    render(<PagarMembresia />);
    expect(await screen.findByText('Esencial')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar los planes." + Reintentar; nunca "No hay planes disponibles"', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    render(<PagarMembresia />);
    expect(await screen.findByText('No pudimos cargar los planes.')).toBeInTheDocument();
    expect(screen.queryByText(/No hay planes disponibles/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    h.resultado = { data: [{ slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, tipo: 'tiempo', clases_incluidas: null, duracion_dias: 30, beneficios: [] }], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBe(2));
    expect(await screen.findByText('Esencial')).toBeInTheDocument();
  });
});
