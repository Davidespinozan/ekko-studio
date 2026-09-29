import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/** PKG-02A (C02 · F10) — VistaSemana: error ≠ semana vacía. */

const h = vi.hoisted(() => ({
  hook: { reservas: [] as Record<string, unknown>[], isLoading: false, error: false, cargado: true, refetch: vi.fn() }
}));
vi.mock('@shared/hooks/useReservasRango', () => ({ useReservasRango: () => h.hook }));

import VistaSemana from '../calendario/VistaSemana';

const montar = () => render(<VistaSemana refreshTick={0} onVerDetalle={vi.fn()} />);

describe('VistaSemana (PKG-02A)', () => {
  beforeEach(() => {
    h.hook = { reservas: [], isLoading: false, error: false, cargado: true, refetch: vi.fn() };
  });

  it('success con [] → cuadrícula vacía y "Reservas en rango: 0" (vacío legítimo)', () => {
    montar();
    expect(screen.getByText('Reservas en rango: 0')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('error sin dato → ErrorCarga + Reintentar, sin cuadrícula ni conteo 0', () => {
    h.hook.error = true;
    h.hook.cargado = false;
    montar();
    expect(screen.getByText('No pudimos cargar las reservas de esta semana.')).toBeInTheDocument();
    expect(screen.queryByText('Reservas en rango: 0')).not.toBeInTheDocument();
    expect(screen.getByText('Reservas en rango: no disponible')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('dato previo + refresh fallido → aviso stale y la cuadrícula se conserva', () => {
    h.hook.reservas = [{ id: 'r1', status: 'confirmada', slot_inicio: new Date().toISOString(), slot_fin: new Date().toISOString(), recurso: { id: 'a', slug: 'a', nombre: 'Set A' }, usuario: { id: 'u', nombre: 'Ana', email: 'a@e.mx', membresia_tier: null } }];
    h.hook.error = true;
    montar();
    expect(screen.getByText(/No pudimos actualizar las reservas/)).toBeInTheDocument();
    expect(screen.getByText('Reservas en rango: 1')).toBeInTheDocument();
  });
});
