import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilaReserva } from '../FilaReserva';
import type { ReservaPerfil } from '../types';

const RESERVA: ReservaPerfil = {
  id: 'r1',
  slot_inicio: '2026-01-01T10:00:00Z',
  slot_fin: '2026-01-01T11:00:00Z',
  status: 'completada',
  folio: 'F-1',
  recurso_id: 'rec1',
  recurso: { nombre: 'Estudio 1' },
  material_requerido: true
};

describe('FilaReserva — toggle "requiere material"', () => {
  it('muestra "Requiere material" cuando material_requerido es true, y llama onToggleMaterialRequerido al hacer clic', () => {
    const onToggle = vi.fn();
    render(<FilaReserva reserva={RESERVA} historico onToggleMaterialRequerido={onToggle} />);
    const btn = screen.getByText('Requiere material');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('muestra "No requiere material" cuando material_requerido es false', () => {
    render(<FilaReserva reserva={{ ...RESERVA, material_requerido: false }} historico onToggleMaterialRequerido={() => {}} />);
    expect(screen.getByText('No requiere material')).toBeInTheDocument();
  });

  it('mientras guarda, muestra "Guardando…" y el botón se deshabilita', () => {
    render(<FilaReserva reserva={RESERVA} historico onToggleMaterialRequerido={() => {}} guardandoMaterialRequerido />);
    const btn = screen.getByText('Guardando…');
    expect(btn).toBeDisabled();
  });

  it('en una reserva CANCELADA no aparece el toggle', () => {
    render(<FilaReserva reserva={{ ...RESERVA, status: 'cancelada' }} historico onToggleMaterialRequerido={() => {}} />);
    expect(screen.queryByText('Requiere material')).not.toBeInTheDocument();
  });

  it('sin el callback, no aparece el toggle (p. ej. en las reservas próximas, con acciones)', () => {
    render(<FilaReserva reserva={RESERVA} onCancelar={() => {}} />);
    expect(screen.queryByText('Requiere material')).not.toBeInTheDocument();
  });
});
