import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Verifica el cableado de CrearReservaModal: que al confirmar llame
 * `reservar_para_miembro_atomic` con `p_usuario_id` = id del MIEMBRO
 * objetivo (no del recepcionista). La lógica de slots (reservaLogic)
 * se mockea — tiene sus propios tests; aquí probamos el wiring.
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
  recursos: [{ id: 'rec-1', nombre: 'Estudio A', tiers_permitidos: ['pro'], horarios: [] }],
  reglasTier: { data: { reglas: { max_invitados: 2 } }, error: null } as { data: unknown; error: unknown },
  recursosError: false,
  recargarRecursos: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    // Límite de invitados del plan (tiers.reglas). Antes el mock no tenía `from`:
    // la lectura lanzaba y el modal asumía 0 invitados en silencio (F09).
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve(h.reglasTier);
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => h.toast }));
vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => h.tenant
}));

vi.mock('@member/hooks/useReservas', () => ({
  useRecursosDelTenant: () => ({ recursos: h.recursosError ? [] : h.recursos, isLoading: false, error: h.recursosError, recargar: h.recargarRecursos }),
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
    h.reglasTier = { data: { reglas: { max_invitados: 2 } }, error: null };
    h.recursosError = false;
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

  it('reprogramar: muestra el contexto y al confirmar llama UNA vez a la RPC atómica reprogramar_reserva', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, reserva_id: 'res-nueva' }, error: null });
    const onCreada = vi.fn();
    const onClose = vi.fn();
    const reprogramarDe = {
      id: 'res-vieja',
      recurso_id: 'rec-1',
      recurso_nombre: 'Estudio A',
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

    // R2-A (PKG-01J): cancelar + crear + traslado + aviso ocurren en el servidor,
    // en una transacción. El navegador ya no orquesta crear/cancelar/avisar.
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc.mock.calls[0][0]).toBe('reprogramar_reserva');
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_reserva_id: 'res-vieja', p_recurso_id: 'rec-1' });
    await waitFor(() => expect(onCreada).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('reprogramar rechazado → toast con "sigue en pie", el modal NO se cierra y no se refresca', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_SLOT_OCUPADO: tomado' } });
    const onCreada = vi.fn();
    const onClose = vi.fn();
    render(
      <CrearReservaModal
        miembro={MIEMBRO}
        reprogramarDe={{ id: 'res-vieja', recurso_id: 'rec-1', recurso_nombre: 'Estudio A', slot_inicio: '2026-06-20T12:00:00.000Z', slot_fin: '2026-06-20T13:00:00.000Z' }}
        onClose={onClose}
        onCreada={onCreada}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reprogramar' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(expect.stringMatching(/sigue en pie/)));
    expect(onCreada).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── PKG-02A (C02 · F09/F11) ───────────────────────────────────────────────────
describe('CrearReservaModal · estados honestos (PKG-02A)', () => {
  beforeEach(() => {
    h.rpc.mockReset();
    h.reglasTier = { data: { reglas: { max_invitados: 2 } }, error: null };
    h.recursosError = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('límite de invitados OK → stepper visible con el máximo del plan', async () => {
    render(<CrearReservaModal miembro={MIEMBRO} onClose={vi.fn()} onCreada={vi.fn()} />);
    expect(await screen.findByText(/Invitados \(0 de 2\)/)).toBeInTheDocument();
  });

  it('límite de invitados en ERROR → no se asume 0: aviso, sin stepper, y Confirmar bloqueado hasta reintentar', async () => {
    h.reglasTier = { data: null, error: { message: 'permission denied' } };
    h.rpc.mockResolvedValue({ data: { success: true }, error: null });
    render(<CrearReservaModal miembro={MIEMBRO} onClose={vi.fn()} onCreada={vi.fn()} />);
    expect(await screen.findByText(/No pudimos cargar cuántos invitados permite el plan/)).toBeInTheDocument();
    expect(screen.queryByText(/Invitados \(/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    const confirmar = screen.getByRole('button', { name: /crear reserva/i });
    expect(confirmar).toBeDisabled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/permission denied/);

    // Reintentar → el límite llega → se puede confirmar.
    h.reglasTier = { data: { reglas: { max_invitados: 1 } }, error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/Invitados \(0 de 1\)/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /crear reserva/i })).not.toBeDisabled());
  });

  it('estudios en ERROR → "No pudimos cargar los estudios", nunca "no tiene acceso a ningún estudio"', async () => {
    h.recursosError = true;
    render(<CrearReservaModal miembro={MIEMBRO} onClose={vi.fn()} onCreada={vi.fn()} />);
    expect(await screen.findByText('No pudimos cargar los estudios.')).toBeInTheDocument();
    expect(screen.queryByText(/no tiene acceso a ningún estudio/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.recargarRecursos).toHaveBeenCalledTimes(1);
  });
});
