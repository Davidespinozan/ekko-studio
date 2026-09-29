import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/** PKG-02A (C02 · F10) — VistaDia: error ≠ "No hay reservas para este día". */

const h = vi.hoisted(() => ({
  hook: { reservas: [] as Record<string, unknown>[], isLoading: false, error: false, cargado: true, refetch: vi.fn() }
}));
vi.mock('../../hooks/useAdminData', () => ({ useReservasRango: () => h.hook }));

import VistaDia from '../calendario/VistaDia';

const RESERVA = { id: 'r1', status: 'confirmada', slot_inicio: '2026-09-28T17:00:00Z', slot_fin: '2026-09-28T18:00:00Z', recurso: { id: 'a', slug: 'a', nombre: 'Set A' }, usuario: { id: 'u', nombre: 'Ana', email: 'a@e.mx', membresia_tier: 'starter' } };
const montar = () => render(<VistaDia refreshTick={0} onVerDetalle={vi.fn()} />);

describe('VistaDia (PKG-02A)', () => {
  beforeEach(() => {
    h.hook = { reservas: [], isLoading: false, error: false, cargado: true, refetch: vi.fn() };
  });

  it('success con [] → "No hay reservas para este día." (vacío legítimo)', () => {
    montar();
    expect(screen.getByText('No hay reservas para este día.')).toBeInTheDocument();
  });

  it('error sin dato → "No pudimos cargar las reservas de este día." + Reintentar; nunca el vacío', () => {
    h.hook.error = true;
    h.hook.cargado = false;
    montar();
    expect(screen.queryByText('No hay reservas para este día.')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar las reservas de este día.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('cargando sin dato → skeleton, ni vacío ni error', () => {
    h.hook.isLoading = true;
    h.hook.cargado = false;
    montar();
    expect(screen.queryByText('No hay reservas para este día.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('dato previo + refresh fallido → la reserva sigue visible + aviso stale', () => {
    h.hook.reservas = [RESERVA];
    h.hook.error = true;
    montar();
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    expect(screen.getByText(/No pudimos actualizar las reservas/)).toBeInTheDocument();
    expect(screen.queryByText('No hay reservas para este día.')).not.toBeInTheDocument();
  });
});
