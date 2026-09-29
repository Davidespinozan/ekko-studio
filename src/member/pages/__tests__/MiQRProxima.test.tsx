import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * PKG-02A (C02 · F08) — /app/qr: un fallo al consultar la próxima reserva NO
 * es "No tienes una sesión próxima" (el miembro está en la puerta).
 */

// `usuario` estable entre renders (como el contexto real): si el mock devolviera un
// objeto nuevo cada vez, el efecto se relanzaría en bucle.
const h = vi.hoisted(() => ({ resultado: { data: null as unknown, error: null as unknown }, llamadas: 0, usuario: { id: 'u-1' } }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'order', 'limit']) c[m] = () => c;
      c.maybeSingle = () => { h.llamadas++; return Promise.resolve(h.resultado); };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario }) }));

import MiQRProxima from '../MiQRProxima';

const montar = () =>
  render(
    <MemoryRouter initialEntries={['/app/qr']}>
      <Routes>
        <Route path="/app/qr" element={<MiQRProxima />} />
        <Route path="/app/qr/:id" element={<div>QR_DE_RESERVA</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('MiQRProxima (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: null, error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success con reserva → redirige al QR', async () => {
    h.resultado = { data: { id: 'res-1' }, error: null };
    montar();
    expect(await screen.findByText('QR_DE_RESERVA')).toBeInTheDocument();
  });

  it('success sin reserva → "No tienes una sesión próxima" (ausencia real)', async () => {
    montar();
    expect(await screen.findByText('No tienes una sesión próxima')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar tu próxima sesión." + Reintentar; NUNCA "No tienes una sesión próxima"', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    montar();
    expect(await screen.findByText('No pudimos cargar tu próxima sesión.')).toBeInTheDocument();
    expect(screen.queryByText('No tienes una sesión próxima')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);

    h.resultado = { data: { id: 'res-9' }, error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBe(2));
    expect(await screen.findByText('QR_DE_RESERVA')).toBeInTheDocument();
  });
});
