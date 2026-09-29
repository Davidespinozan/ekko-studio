import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/** PKG-02B (C04) — invitados extra: sin "+1" optimista; el total mostrado es el observado en la reserva. */

const h = vi.hoisted(() => ({
  observar: vi.fn(),
  leerReserva: vi.fn()
}));
vi.mock('@shared/components/PaymentModal', () => ({
  PaymentModal: (p: { onPagado: (x: { paymentIntentId: string }) => void; onEnProceso?: (x: { paymentIntentId: string }) => void }) => (
    <div>
      <button onClick={() => p.onPagado({ paymentIntentId: 'pi_inv' })}>SIMULAR_SUCCEEDED</button>
      <button onClick={() => p.onEnProceso?.({ paymentIntentId: 'pi_inv' })}>SIMULAR_PROCESSING</button>
    </div>
  )
}));
vi.mock('@shared/lib/observarActivacion', () => ({ observarActivacion: (...a: unknown[]) => h.observar(...a) }));
vi.mock('@shared/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => h.leerReserva() }) }) }) } }));

import { PagarInvitadosExtra } from '../PagarInvitadosExtra';

describe('PagarInvitadosExtra (PKG-02B)', () => {
  beforeEach(() => {
    h.observar.mockReset();
    window.sessionStorage.clear();
  });

  it('27 · succeeded → observa la reserva y entrega el TOTAL observado (no pagados+1)', async () => {
    h.observar.mockResolvedValue({ resultado: 'observada', dato: { invitados_extra_pagados: 5 } });
    const onRegistrado = vi.fn();
    render(<PagarInvitadosExtra reservaId="r1" precioExtraCentavos={15000} maxCantidad={4} pagadosActuales={2} cantidadFija={3} onClose={vi.fn()} onRegistrado={onRegistrado} />);
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith(5));
    // La condición de "listo" exige pagadosActuales + cantidad (2 + 3 = 5), no +1.
    const opts = h.observar.mock.calls[0][0] as { listo: (r: { invitados_extra_pagados: number }) => boolean };
    expect(opts.listo({ invitados_extra_pagados: 3 })).toBe(false);
    expect(opts.listo({ invitados_extra_pagados: 5 })).toBe(true);
  });

  it('registro tardío → pendiente con "Volver a comprobar" (solo lectura) y sin onRegistrado', async () => {
    h.observar.mockResolvedValueOnce({ resultado: 'no_observada', ultimo: { invitados_extra_pagados: 2 } });
    const onRegistrado = vi.fn();
    const onPendiente = vi.fn();
    render(<PagarInvitadosExtra reservaId="r1" precioExtraCentavos={15000} maxCantidad={4} pagadosActuales={2} cantidadFija={1} onClose={vi.fn()} onRegistrado={onRegistrado} onPendiente={onPendiente} />);
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    expect(await screen.findByText(/tardando más de lo normal/)).toBeInTheDocument();
    expect(screen.getByText(/No vuelvas a pagar/)).toBeInTheDocument();
    expect(onRegistrado).not.toHaveBeenCalled();
    expect(onPendiente).toHaveBeenCalledTimes(1);
    h.observar.mockResolvedValueOnce({ resultado: 'observada', dato: { invitados_extra_pagados: 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a comprobar' }));
    await waitFor(() => expect(onRegistrado).toHaveBeenCalledWith(3));
    expect(h.observar).toHaveBeenCalledTimes(2); // solo lecturas; PaymentModal no se volvió a abrir
  });

  it('error de lectura → "No pudimos comprobar", no "registrados" ni fallo de pago', async () => {
    h.observar.mockResolvedValue({ resultado: 'error' });
    render(<PagarInvitadosExtra reservaId="r1" precioExtraCentavos={15000} maxCantidad={4} cantidadFija={1} onClose={vi.fn()} onRegistrado={vi.fn()} />);
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    expect(await screen.findByText(/No pudimos comprobar el registro/)).toBeInTheDocument();
    expect(screen.getByText('PAGO RECIBIDO')).toBeInTheDocument();
  });

  it('processing → "PAGO EN PROCESO", sin onRegistrado ni "Volver a comprobar"', async () => {
    const onRegistrado = vi.fn();
    render(<PagarInvitadosExtra reservaId="r1" precioExtraCentavos={15000} maxCantidad={4} cantidadFija={1} onClose={vi.fn()} onRegistrado={onRegistrado} />);
    fireEvent.click(screen.getByText('SIMULAR_PROCESSING'));
    expect(await screen.findByText('PAGO EN PROCESO')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver a comprobar' })).not.toBeInTheDocument();
    expect(onRegistrado).not.toHaveBeenCalled();
    expect(h.observar).not.toHaveBeenCalled();
  });

  it('paso de cantidad: sin cantidadFija se elige y luego se abre el pago', async () => {
    render(<PagarInvitadosExtra reservaId="r1" precioExtraCentavos={15000} maxCantidad={3} onClose={vi.fn()} onRegistrado={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pagar \$300$/ }));
    expect(await screen.findByText('SIMULAR_SUCCEEDED')).toBeInTheDocument();
  });
});
