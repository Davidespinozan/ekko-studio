import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-02A (C02 · F01) — la tarjeta de pendientes del admin: con `error` NO dice
 * "Todo al día"; con 0 reales sí; cargando no muestra ni lo uno ni lo otro.
 */

const h = vi.hoisted(() => ({
  hook: {
    conteo: { cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0 },
    isLoading: false,
    error: false,
    refetch: vi.fn()
  }
}));
vi.mock('../../hooks/useCentroPendientes', () => ({ useCentroPendientes: () => h.hook }));

import { CentroPendientes } from '../CentroPendientes';

const montar = () => render(<MemoryRouter><CentroPendientes /></MemoryRouter>);

describe('CentroPendientes (PKG-02A)', () => {
  beforeEach(() => {
    h.hook.isLoading = false;
    h.hook.error = false;
    h.hook.conteo = { cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0 };
    h.hook.refetch = vi.fn();
  });

  it('success con 0 pendientes → "Todo al día" (vacío legítimo)', () => {
    montar();
    expect(screen.getByText('Todo al día')).toBeInTheDocument();
  });

  it('success con pendientes → tarjetas con conteo, sin "Todo al día"', () => {
    h.hook.conteo = { cobrosPendientes: 2, identidadPendiente: 0, membresiasVencidas: 1, noShows7d: 0 };
    montar();
    expect(screen.queryByText('Todo al día')).not.toBeInTheDocument();
    expect(screen.getByText('Cobros pendientes')).toBeInTheDocument();
    expect(screen.getByText('Membresía vencida')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar los pendientes" + Reintentar; NUNCA "Todo al día" ni 0', () => {
    h.hook.error = true;
    montar();
    expect(screen.queryByText('Todo al día')).not.toBeInTheDocument();
    expect(screen.queryByText('No hay pendientes operativos ahora mismo.')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar los pendientes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('cargando → skeleton, sin "Todo al día" ni error', () => {
    h.hook.isLoading = true;
    montar();
    expect(screen.queryByText('Todo al día')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
