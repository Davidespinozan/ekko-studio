import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Atajos de mostrador en "Hoy" (R7 de la paridad SALA):
 *  - check-in de UN toque desde "Llegando ahora" (mismo RPC y mismo detalle
 *    que el modal, así el aviso de membresía no se pierde);
 *  - cancelar la reserva desde la tarjeta (antes: ir al perfil);
 *  - búsqueda por teléfono;
 *  - aviso de ficha/contrato pendiente en la tarjeta.
 */

const h = vi.hoisted(() => ({
  reservas: [] as Record<string, unknown>[],
  isLoading: false,
  error: false,
  cargado: true,
  recursosError: null as unknown,
  refetch: vi.fn(),
  checkInManual: vi.fn(),
  onSuccess: vi.fn()
}));

vi.mock('../../hooks/useReservasHoy', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useReservasHoy')>()), // conserva estadoListaHoy (puro)
  useReservasHoy: () => ({ reservas: h.reservas, isLoading: h.isLoading, error: h.error, cargado: h.cargado, refetch: h.refetch }),
  checkInManual: (...a: unknown[]) => h.checkInManual(...a)
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) b[m] = () => b;
      b.then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(tabla === 'recursos' && h.recursosError ? { data: null, error: h.recursosError } : { data: [], error: null }).then(cb);
      return b;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));
vi.mock('../../lib/checkInFeedback', () => ({ playCheckInSuccess: vi.fn(), playCheckInError: vi.fn() }));
vi.mock('../CancelarReservaRecepcionModal', () => ({
  CancelarReservaRecepcionModal: (p: { reserva: { id: string }; miembroNombre: string }) => (
    <div data-testid="modal-cancelar">cancelar {p.reserva.id} de {p.miembroNombre}</div>
  )
}));

import { ReservasHoyView } from '../ReservasHoyView';

function reservaLlegando(extra: Record<string, unknown> = {}) {
  const inicio = Date.now() + 5 * 60_000; // empieza en 5 min → "llegando ahora"
  return {
    id: 'res-1',
    folio: 'EK-0001',
    status: 'confirmada',
    slot_inicio: new Date(inicio).toISOString(),
    slot_fin: new Date(inicio + 60 * 60_000).toISOString(),
    recurso: { id: 'r1', slug: 'black', nombre: 'Set Black' },
    usuario: {
      id: 'u1',
      nombre: 'ana núñez',
      email: 'ana@ekko.mx',
      membresia_tier: 'esencial',
      telefono: '+52 667 123 4567',
      avatar_url: null,
      identidad_completa: true,
      contrato_firmado: true
    },
    ...extra
  };
}

function renderHoy() {
  return render(
    <ToastProvider>
      <ReservasHoyView onManualCheckInSuccess={h.onSuccess} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reservas = [reservaLlegando()];
  h.isLoading = false;
  h.error = false;
  h.cargado = true;
  h.recursosError = null;
  h.refetch.mockResolvedValue(undefined);
  h.checkInManual.mockResolvedValue({ miembro: { id: 'u1' }, membresia_estado: 'vencida' });
});

describe('ReservasHoyView · atajos de mostrador', () => {
  it('check-in de un toque: llama al RPC con la reserva y entrega el resultado al detalle', async () => {
    renderHoy();
    fireEvent.click(await screen.findByRole('button', { name: /check-in de ana núñez/i }));
    await waitFor(() => expect(h.checkInManual).toHaveBeenCalledWith('res-1'));
    await waitFor(() => expect(h.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ membresia_estado: 'vencida' })));
    expect(h.refetch).toHaveBeenCalled();
  });

  it('si el RPC rechaza, no entrega nada al detalle y el botón vuelve a estar disponible', async () => {
    h.checkInManual.mockRejectedValueOnce(new Error('Es muy temprano para el check-in'));
    renderHoy();
    const btn = await screen.findByRole('button', { name: /check-in de ana núñez/i });
    fireEvent.click(btn);
    await waitFor(() => expect(h.checkInManual).toHaveBeenCalledTimes(1));
    expect(h.onSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('cancelar desde la tarjeta: abre el modal de cancelación del estudio', async () => {
    renderHoy();
    fireEvent.click(await screen.findByText('Ana Núñez'));
    fireEvent.click(screen.getByRole('button', { name: /cancelar la reserva/i }));
    expect(screen.getByTestId('modal-cancelar')).toHaveTextContent('cancelar res-1 de Ana Núñez');
  });

  it('una reserva que YA empezó no ofrece cancelar (solo no-show)', async () => {
    const inicio = Date.now() - 5 * 60_000;
    h.reservas = [reservaLlegando({ slot_inicio: new Date(inicio).toISOString(), slot_fin: new Date(inicio + 3_600_000).toISOString() })];
    renderHoy();
    fireEvent.click(await screen.findByText('Ana Núñez'));
    expect(screen.queryByRole('button', { name: /cancelar la reserva/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no llegó/i })).toBeInTheDocument();
  });

  it('busca por los últimos dígitos del teléfono', async () => {
    renderHoy();
    await screen.findByText('Ana Núñez');
    fireEvent.change(screen.getByLabelText('Buscar reserva'), { target: { value: '4567' } });
    expect(await screen.findByText('Ana Núñez')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Buscar reserva'), { target: { value: '9999' } });
    expect(await screen.findByText('Sin coincidencias')).toBeInTheDocument();
  });

  it('avisa en la tarjeta cuando la ficha de identidad o el contrato están pendientes', async () => {
    h.reservas = [reservaLlegando({ usuario: { ...reservaLlegando().usuario as object, identidad_completa: false } })];
    renderHoy();
    expect(await screen.findByText(/ficha o contrato pendiente/i)).toBeInTheDocument();
  });
});

// ── PKG-02A (C02 · F02) · error ≠ "Sin reservas"; polling fallido = stale ─────
describe('ReservasHoyView · estados honestos (PKG-02A)', () => {
  it('success con [] → "Sin reservas para hoy" (vacío real)', async () => {
    h.reservas = [];
    renderHoy();
    expect(await screen.findByText('Sin reservas para hoy')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('primer fetch fallido (sin dato) → "No pudimos cargar las reservas de hoy." + Reintentar; NUNCA "Sin reservas"', async () => {
    h.reservas = [];
    h.error = true;
    h.cargado = false;
    renderHoy();
    expect(await screen.findByText('No pudimos cargar las reservas de hoy.')).toBeInTheDocument();
    expect(screen.queryByText('Sin reservas para hoy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it('cargando inicial → skeletons, ni vacío ni error', () => {
    h.reservas = [];
    h.isLoading = true;
    h.cargado = false;
    renderHoy();
    expect(screen.queryByText('Sin reservas para hoy')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lista previa válida + refresh fallido → la lista SE CONSERVA y aparece "No pudimos actualizar la lista"', async () => {
    h.error = true;
    h.cargado = true;
    renderHoy();
    expect(await screen.findByText(/Ana Núñez/)).toBeInTheDocument(); // la reserva sigue visible
    expect(screen.getByText(/No pudimos actualizar la lista/)).toBeInTheDocument();
    expect(screen.queryByText('Sin reservas para hoy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});

// ── PKG-02A (F23) · filtro de estudios ───────────────────────────────────────
describe('ReservasHoyView · filtro de estudios (PKG-02A)', () => {
  it('error del catálogo → opción "Estudios no disponibles" (no un selector vacío que parece "sin estudios")', async () => {
    h.recursosError = { message: 'timeout' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHoy();
    expect(await screen.findByRole('option', { name: /Estudios no disponibles/ })).toBeInTheDocument();
  });
});
