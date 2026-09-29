import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CLAVE_PAGO_PENDIENTE, MENSAJE_PAGO, PAGO_PENDIENTE_ANTIGUO_MS } from '@shared/lib/pagoEstado';

/**
 * PKG-02B (C04) — /app/pagar: PAGO CONFIRMADO ≠ CUENTA ACTIVA. Tras `succeeded`
 * se OBSERVA usuarios.status (solo lectura); nada de reload ciego; mientras el
 * pago no se resuelva no se vuelve a ofrecer "Pagar".
 */

const h = vi.hoisted(() => ({
  observar: vi.fn(),
  refreshUsuario: vi.fn(),
  modal: vi.fn(),
  usuario: { id: 'u-1', nombre: 'Ana', membresia_tier: 'esencial', status: 'pendiente_pago' },
  tiers: [{ slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, tipo: 'tiempo', clases_incluidas: null, duracion_dias: 30, beneficios: [] }]
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => Promise.resolve({ data: h.tiers, error: null });
      c.maybeSingle = () => Promise.resolve({ data: { status: 'pendiente_pago' }, error: null });
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario, signOut: vi.fn(), refreshUsuario: (...a: unknown[]) => h.refreshUsuario(...a) }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', nombre: 'EKKO', config: {} }) }));
vi.mock('@shared/lib/observarActivacion', () => ({ observarActivacion: (...a: unknown[]) => h.observar(...a) }));
vi.mock('@shared/components/PaymentModal', () => ({
  PaymentModal: (p: { flujo?: string; onPagado: (x: { paymentIntentId: string }) => void; onEnProceso?: (x: { paymentIntentId: string }) => void }) => {
    h.modal(p.flujo);
    return (
      <div>
        <button onClick={() => p.onPagado({ paymentIntentId: 'pi_m' })}>SIMULAR_SUCCEEDED</button>
        <button onClick={() => p.onEnProceso?.({ paymentIntentId: 'pi_m' })}>SIMULAR_PROCESSING</button>
      </div>
    );
  }
}));

import PagarMembresia from '../PagarMembresia';

async function pagar() {
  render(<PagarMembresia />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pagar ahora' }));
  return screen.findByText('SIMULAR_SUCCEEDED');
}

beforeEach(() => {
  h.observar.mockReset();
  h.refreshUsuario.mockReset().mockResolvedValue(undefined);
  h.modal.mockReset();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/app');
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('PagarMembresia · veracidad de pago (PKG-02B)', () => {
  it('13 · succeeded → observa la activación; al verla refresca al usuario y limpia el pendiente (sin reload)', async () => {
    h.observar.mockResolvedValue({ resultado: 'observada', dato: { status: 'activo' } });
    await pagar();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    await waitFor(() => expect(h.refreshUsuario).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)).toBeNull();
    // La evidencia esperada es que la cuenta deje de estar pendiente de pago.
    const opts = h.observar.mock.calls[0][0] as { listo: (u: { status: string | null }) => boolean };
    expect(opts.listo({ status: 'pendiente_pago' })).toBe(false);
    expect(opts.listo({ status: null })).toBe(false);
    expect(opts.listo({ status: 'activo' })).toBe(true);
  });

  it('14 · activación no observada → "Pago recibido" + "Volver a comprobar" (solo lectura); nunca "Pagar" ni "activa"', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: { status: 'pendiente_pago' } });
    await pagar();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    expect(await screen.findByText(MENSAJE_PAGO.activacionTarda)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pago recibido' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(h.refreshUsuario).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a comprobar' }));
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(2));
    expect(h.modal).toHaveBeenCalledTimes(1); // no se reabrió el pago
    expect(screen.getByText(/No pagues otra vez/)).toBeInTheDocument();
  });

  it('15 · error al leer → "No pudimos comprobar la activación" (no "fallido", no "activa")', async () => {
    h.observar.mockResolvedValue({ resultado: 'error' });
    await pagar();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    expect(await screen.findByText(MENSAJE_PAGO.comprobacionFallo)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a comprobar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
  });

  it('16 · processing → "Pago en proceso": sin "Pagar", sin "Volver a comprobar", sin observar todavía', async () => {
    await pagar();
    fireEvent.click(screen.getByText('SIMULAR_PROCESSING'));
    expect(await screen.findByRole('heading', { name: 'Pago en proceso' })).toBeInTheDocument();
    expect(screen.getByText(MENSAJE_PAGO.pagoEnProcesoPersistido)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Volver a comprobar' })).not.toBeInTheDocument();
    expect(h.observar).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!)).toMatchObject({ flujo: 'pagar', estado: 'en_proceso', paymentIntentId: 'pi_m' });
  });

  it('18 · pendiente confirmado persistido (refresh) → arranca en pendiente, observa, y no ofrece "Pagar"', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: { status: 'pendiente_pago' } });
    window.sessionStorage.setItem(CLAVE_PAGO_PENDIENTE, JSON.stringify({ flujo: 'pagar', paymentIntentId: 'pi_prev', estado: 'confirmado', ts: Date.now() - 60_000 }));
    render(<PagarMembresia />);
    expect(await screen.findByTestId('pago-pendiente')).toBeInTheDocument();
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('19 · pendiente ANTIGUO (>30 min) solo cambia el copy: sigue sin ofrecer otro pago', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: { status: 'pendiente_pago' } });
    window.sessionStorage.setItem(CLAVE_PAGO_PENDIENTE, JSON.stringify({ flujo: 'pagar', paymentIntentId: 'pi_old', estado: 'confirmado', ts: Date.now() - PAGO_PENDIENTE_ANTIGUO_MS - 1000 }));
    render(<PagarMembresia />);
    expect(await screen.findByText(MENSAJE_PAGO.activacionSinConfirmar)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a comprobar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('20 · retorno de redirect fallido → "El pago no se completó…" y SÍ se puede pagar; no queda pendiente', async () => {
    window.history.replaceState(null, '', '/app?pago=pagar&payment_intent=pi_r&payment_intent_client_secret=pi_r_secret_x&redirect_status=requires_payment_method');
    render(<PagarMembresia />);
    expect(await screen.findByText(MENSAJE_PAGO.noCompletado)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pagar ahora' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)).toBeNull();
    expect(window.location.search).toBe(''); // la URL se limpia; el client_secret no se conserva
  });

  it('20b · retorno de redirect succeeded → pendiente confirmado con el id (sin client secret) y se observa', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: { status: 'pendiente_pago' } });
    window.history.replaceState(null, '', '/app?pago=pagar&payment_intent=pi_r&payment_intent_client_secret=pi_r_secret_x&redirect_status=succeeded');
    render(<PagarMembresia />);
    expect(await screen.findByTestId('pago-pendiente')).toBeInTheDocument();
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    const raw = window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!;
    expect(JSON.parse(raw)).toMatchObject({ flujo: 'pagar', paymentIntentId: 'pi_r', estado: 'confirmado' });
    expect(raw).not.toMatch(/secret/);
  });
});
