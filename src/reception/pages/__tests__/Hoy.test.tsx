import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * "QR bloquea, manual avisa": el check-in manual NO bloquea por membresía; el RPC
 * devuelve `membresia_estado` y la única pantalla que lo pinta es CheckInDetail.
 * Hoy montaba <ReservasHoyView /> sin `onManualCheckInSuccess`, así que el aviso
 * se descartaba y un miembro vencido entraba por mostrador sin que nadie lo notara.
 */

let dispararCheckIn: (data: unknown) => void = () => {};
const pollingVisto: boolean[] = [];

vi.mock('../../components/ReservasHoyView', () => ({
  ReservasHoyView: (p: { onManualCheckInSuccess?: (d: unknown) => void; pausarPolling?: boolean }) => {
    dispararCheckIn = (d) => p.onManualCheckInSuccess?.(d);
    pollingVisto.push(!!p.pausarPolling);
    return (
      <button
        onClick={() =>
          dispararCheckIn({
            miembro: { id: 'm1', nombre: 'Ana Vencida' },
            recurso: { id: 'r1', nombre: 'Black' },
            reserva: { id: 'res1' },
            stats: { check_ins_hoy: 1, check_ins_semana: 1 },
            membresia_estado: 'vencida'
          })
        }
      >
        SIMULAR_CHECKIN_MANUAL
      </button>
    );
  }
}));

vi.mock('../../components/CheckInDetail', () => ({
  CheckInDetail: (p: { kind: string; miembro?: { nombre: string }; membresiaEstado?: string; onClose: () => void }) => (
    <div data-testid="detalle">
      {p.kind} · {p.miembro?.nombre} · {p.membresiaEstado}
      <button onClick={p.onClose}>CERRAR</button>
    </div>
  )
}));

vi.mock('@shared/components/CumpleanosCard', () => ({ CumpleanosCard: () => null }));

import Hoy from '../Hoy';

describe('Hoy — el check-in manual abre el detalle con el aviso de membresía', () => {
  it('sin check-in no hay detalle', () => {
    render(<Hoy />);
    expect(screen.queryByTestId('detalle')).not.toBeInTheDocument();
  });

  it('tras el check-in manual muestra CheckInDetail con el membresia_estado del RPC y pausa el polling', () => {
    render(<Hoy />);
    fireEvent.click(screen.getByText('SIMULAR_CHECKIN_MANUAL'));

    expect(screen.getByTestId('detalle')).toHaveTextContent('success · Ana Vencida · vencida');
    expect(pollingVisto.at(-1)).toBe(true);
  });

  it('al cerrar el detalle vuelve a Hoy y reanuda el polling', () => {
    render(<Hoy />);
    fireEvent.click(screen.getByText('SIMULAR_CHECKIN_MANUAL'));
    fireEvent.click(screen.getByText('CERRAR'));

    expect(screen.queryByTestId('detalle')).not.toBeInTheDocument();
    expect(pollingVisto.at(-1)).toBe(false);
  });
});
