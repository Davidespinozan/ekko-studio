import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** PKG-02A (C02 · F21) — la campana: primer fallo ≠ "Estás al día"; polling fallido con avisos previos → lista + aviso. */

const h = vi.hoisted(() => ({
  hook: {
    notificaciones: [] as Record<string, unknown>[],
    noLeidas: 0,
    error: false,
    cargado: true,
    marcarLeida: vi.fn(),
    marcarTodas: vi.fn(),
    refetch: vi.fn()
  }
}));
vi.mock('@shared/hooks/useNotificacionesMiembro', () => ({ useNotificacionesMiembro: () => h.hook }));

import { NotificacionesBell } from '../NotificacionesBell';

const AVISO = { id: 'n1', tipo: 'aviso_manual', titulo: 'Tu material está listo', mensaje: 'Descárgalo', metadata: null, creada_at: new Date().toISOString(), leida: false };

function abrir() {
  render(<MemoryRouter><NotificacionesBell /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /notificaciones/i }));
}

describe('NotificacionesBell (PKG-02A)', () => {
  beforeEach(() => {
    h.hook = { notificaciones: [], noLeidas: 0, error: false, cargado: true, marcarLeida: vi.fn(), marcarTodas: vi.fn(), refetch: vi.fn() };
  });

  it('success vacío → "Estás al día" (vacío real)', () => {
    abrir();
    expect(screen.getByText('Estás al día')).toBeInTheDocument();
  });

  it('primer fetch fallido → "No pudimos cargar tus notificaciones." + Reintentar; nunca "Estás al día"', () => {
    h.hook.error = true;
    h.hook.cargado = false;
    abrir();
    expect(screen.queryByText('Estás al día')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar tus notificaciones.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('avisos previos + refresh fallido → la lista se conserva + "No pudimos actualizar"', () => {
    h.hook.notificaciones = [AVISO];
    h.hook.noLeidas = 1;
    h.hook.error = true;
    abrir();
    expect(screen.getByText('Tu material está listo')).toBeInTheDocument();
    expect(screen.getByText('No pudimos actualizar tus notificaciones.')).toBeInTheDocument();
    expect(screen.queryByText('Estás al día')).not.toBeInTheDocument();
  });
});
