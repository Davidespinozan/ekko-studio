import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Verifica el cableado de CrearReservaModal: que al confirmar llame
 * `reservar_para_miembro_atomic` con `p_usuario_id` = id del MIEMBRO
 * objetivo (no del recepcionista). La lógica de slots (reservaLogic)
 * se mockea — tiene sus propios tests; acá probamos el wiring.
 *
 * IMPORTANTE: los mocks de hooks (`useTenant`, `useRecursosDelTenant`)
 * devuelven SIEMPRE la misma referencia. El componente memoiza `config`
 * sobre `tenant.config` y lo usa como dependencia de un `useEffect`; si
 * el mock devolviera un objeto nuevo en cada render (cosa que los hooks
 * reales no hacen — `useTenant` lee de un `useState`) se dispararía un
 * bucle infinito de renders. Las constantes van en `vi.hoisted`.
 */

const h = vi.hoisted(() => ({
  slotInicio: new Date('2026-07-01T16:00:00.000Z'),
  slotFin: new Date('2026-07-01T17:00:00.000Z'),
  rpc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  tenant: { id: 't-1', config: { reserva: {} } },
  recursos: [{ id: 'rec-1', nombre: 'Estudio A', tiers_permitidos: ['pro'], horarios: [] }]
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a) }
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => h.toast }));
vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => h.tenant
}));

vi.mock('@member/hooks/useReservas', () => ({
  useRecursosDelTenant: () => ({ recursos: h.recursos, isLoading: false }),
  fetchReservasDelRecurso: () => Promise.resolve([]),
  fetchReservasDelUsuario: () => Promise.resolve([])
}));

vi.mock('@member/logic/reservaLogic', () => ({
  generarFechasReservables: () => [
    { fechaISO: '2026-07-01', date: new Date('2026-07-01T00:00:00'), label: 'Hoy' }
  ],
  generarSlotsDisponibles: () => [
    { inicio: h.slotInicio, fin: h.slotFin, disponible: true }
  ],
  filtrarRecursosPorTier: (recursos: unknown[]) => recursos,
  formatHora: () => '10:00',
  traducirErrorRPC: (m: string) => m
}));

import { CrearReservaModal } from '../CrearReservaModal';

const MIEMBRO = { id: 'm-1', nombre: 'Ana López', membresia_tier: 'pro' };

describe('CrearReservaModal · wiring', () => {
  beforeEach(() => {
    h.rpc.mockReset();
    h.toast.success.mockReset();
    h.toast.error.mockReset();
  });

  it('confirmar reserva → llama reservar_para_miembro_atomic con p_usuario_id del miembro', async () => {
    h.rpc.mockResolvedValue({ data: { success: true }, error: null });
    const onCreada = vi.fn();
    const onClose = vi.fn();

    render(<CrearReservaModal miembro={MIEMBRO} onClose={onClose} onCreada={onCreada} />);

    // El slot aparece tras el fetch + generarSlotsDisponibles (mockeado).
    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    fireEvent.click(screen.getByRole('button', { name: /crear reserva/i }));

    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith('reservar_para_miembro_atomic', {
      p_usuario_id: 'm-1', // el MIEMBRO, no el caller
      p_recurso_id: 'rec-1',
      p_slot_inicio: h.slotInicio.toISOString(),
      p_duracion_min: 60,
      p_invitados: 0,
      p_notas: null
    });
    await waitFor(() => expect(onCreada).toHaveBeenCalled());
  });

  it('error del RPC → toast traducido, no cierra', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'EKKO_SLOT_OCUPADO: tomado' }
    });
    const onCreada = vi.fn();
    const onClose = vi.fn();

    render(<CrearReservaModal miembro={MIEMBRO} onClose={onClose} onCreada={onCreada} />);
    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    fireEvent.click(screen.getByRole('button', { name: /crear reserva/i }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(onCreada).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reprogramar: muestra el contexto y al confirmar orquesta crear + cancelar', async () => {
    h.rpc.mockResolvedValue({ error: null });
    const onCreada = vi.fn();
    const onClose = vi.fn();
    const reprogramarDe = {
      id: 'res-vieja',
      recurso_id: 'rec-1',
      recurso_nombre: 'Estudio A',
      // Lejos del slot nuevo → orden crear→cancelar.
      slot_inicio: '2026-06-20T12:00:00.000Z',
      slot_fin: '2026-06-20T13:00:00.000Z'
    };

    render(
      <CrearReservaModal
        miembro={MIEMBRO}
        reprogramarDe={reprogramarDe}
        onClose={onClose}
        onCreada={onCreada}
      />
    );

    expect(screen.getByText('REPROGRAMAR RESERVA')).toBeInTheDocument();
    expect(screen.getByText(/MOVIENDO ESTA RESERVA/i)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reprogramar' }));

    // Orquesta los dos RPCs de RP-1: crear la nueva + cancelar la vieja.
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    const fns = h.rpc.mock.calls.map((c) => c[0]);
    expect(fns).toContain('reservar_para_miembro_atomic');
    expect(fns).toContain('cancelar_reserva_atomic');
    await waitFor(() => expect(onCreada).toHaveBeenCalled());
  });
});
