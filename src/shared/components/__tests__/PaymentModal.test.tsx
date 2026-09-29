import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * PKG-02B (C04) — PaymentModal afirma solo lo que Stripe.js devuelve:
 * `onPagado` únicamente con `paymentIntent.status === 'succeeded'`; processing /
 * requires_* / sin PI / error → nunca éxito; sin errores crudos; sin doble submit.
 */

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', 'pk_test_ficticia');
  return {
    confirmPayment: vi.fn(),
    submit: vi.fn(),
    intent: { clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago' } as Record<string, unknown>
  };
});

vi.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve({}) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: (p: { children: React.ReactNode }) => <>{p.children}</>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: (...a: unknown[]) => h.confirmPayment(...a) }),
  useElements: () => ({ submit: (...a: unknown[]) => h.submit(...a) })
}));
vi.mock('@shared/lib/checkout', () => ({ crearPagoIntent: () => Promise.resolve(h.intent) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: { id: 'u-1', nombre: 'Ana' } }) }));

import { PaymentModal } from '../PaymentModal';
import { CLAVE_PAGO_PENDIENTE } from '@shared/lib/pagoEstado';

async function montarYPagar(props: Partial<React.ComponentProps<typeof PaymentModal>> = {}) {
  const onPagado = vi.fn();
  const onEnProceso = vi.fn();
  render(<PaymentModal tierSlug="starter" tierNombre="Starter" precio={650} esPaquete flujo="perfil" onClose={vi.fn()} onPagado={onPagado} onEnProceso={onEnProceso} {...props} />);
  const boton = await screen.findByRole('button', { name: 'Pagar ahora' });
  fireEvent.click(boton);
  return { onPagado, onEnProceso };
}

describe('PaymentModal (PKG-02B)', () => {
  beforeEach(() => {
    h.confirmPayment.mockReset();
    h.submit.mockReset().mockResolvedValue({ error: undefined });
    window.sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('1 · confirmPayment devuelve error → NO onPagado; mensaje de Stripe apto para el usuario', async () => {
    h.confirmPayment.mockResolvedValue({ error: { type: 'card_error', message: 'Tu tarjeta fue rechazada.' } });
    const { onPagado } = await montarYPagar();
    expect(await screen.findByText('Tu tarjeta fue rechazada.')).toBeInTheDocument();
    expect(onPagado).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)).toBeNull();
    // Se puede reintentar con el MISMO PaymentIntent.
    expect(screen.getByRole('button', { name: 'Pagar ahora' })).toBeInTheDocument();
  });

  it('2 · succeeded → onPagado exactamente una vez con el id; persiste el pendiente SIN client secret', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_ok', status: 'succeeded' } });
    const { onPagado, onEnProceso } = await montarYPagar();
    await waitFor(() => expect(onPagado).toHaveBeenCalledTimes(1));
    expect(onPagado).toHaveBeenCalledWith({ paymentIntentId: 'pi_ok' });
    expect(onEnProceso).not.toHaveBeenCalled();
    const raw = window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!;
    expect(JSON.parse(raw)).toMatchObject({ flujo: 'perfil', paymentIntentId: 'pi_ok', estado: 'confirmado' });
    expect(raw).not.toMatch(/cs_ficticio|secret|Ana/);
    // La URL de retorno conserva el flujo.
    const args = h.confirmPayment.mock.calls[0][0] as { confirmParams: { return_url: string }; redirect: string };
    expect(args.confirmParams.return_url).toMatch(/\/app\/perfil\?pago=perfil$/);
    expect(args.redirect).toBe('if_required');
  });

  it('3 · processing → NO onPagado; onEnProceso; mensaje "en proceso, no lo repitas"; botón de pago oculto', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_proc', status: 'processing' } });
    const { onPagado, onEnProceso } = await montarYPagar();
    expect(await screen.findByText(/en proceso/)).toBeInTheDocument();
    expect(onPagado).not.toHaveBeenCalled();
    expect(onEnProceso).toHaveBeenCalledWith({ paymentIntentId: 'pi_proc' });
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!)).toMatchObject({ estado: 'en_proceso' });
  });

  it('4 · requires_action → NO éxito; mensaje seguro; se puede reintentar el mismo intento', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_ra', status: 'requires_action' } });
    const { onPagado } = await montarYPagar();
    expect(await screen.findByText(/verificación del pago/)).toBeInTheDocument();
    expect(onPagado).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pagar ahora' })).toBeInTheDocument();
  });

  it('5 · requires_payment_method → NO éxito', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_rpm', status: 'requires_payment_method' } });
    const { onPagado } = await montarYPagar();
    expect(await screen.findByText(/no se completó/)).toBeInTheDocument();
    expect(onPagado).not.toHaveBeenCalled();
  });

  it('6 · resultado sin PI y sin error → desconocido: NO éxito, NO "vuelve a pagar" (botón oculto), pendiente registrado', async () => {
    h.confirmPayment.mockResolvedValue({});
    const { onPagado } = await montarYPagar();
    expect(await screen.findByText(/No pudimos confirmar el resultado del pago/)).toBeInTheDocument();
    expect(onPagado).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!)).toMatchObject({ estado: 'desconocido' });
  });

  it('7/8 · doble submit bloqueado: dos clics → una sola confirmación y un solo callback', async () => {
    let resolver: (v: unknown) => void = () => {};
    h.confirmPayment.mockImplementation(() => new Promise((r) => { resolver = r; }));
    const { onPagado } = await montarYPagar();
    // Mientras confirma, el botón muestra un spinner y está deshabilitado; forzamos el submit del form.
    const form = screen.getByTestId('payment-element').closest('form')!;
    expect(screen.getByRole('button', { name: '' })).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.submit(form);
    resolver({ paymentIntent: { id: 'pi_once', status: 'succeeded' } });
    await waitFor(() => expect(onPagado).toHaveBeenCalledTimes(1));
    expect(h.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it('17 · error técnico de Stripe (api_error) o excepción → mensaje genérico, nunca el texto crudo', async () => {
    h.confirmPayment.mockResolvedValue({ error: { type: 'api_error', message: 'Internal error pi_zzz at webhook.ts:42' } });
    await montarYPagar();
    expect(await screen.findByText(/No se pudo procesar el pago/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pi_zzz|webhook\.ts|Internal/);

    h.confirmPayment.mockRejectedValue(new Error('TypeError: fetch failed at supabase'));
    fireEvent.click(screen.getByRole('button', { name: 'Pagar ahora' }));
    expect(await screen.findByText(/No pudimos confirmar el resultado del pago/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fetch failed|supabase/);
  });

  it('abrir el pago falla → mensaje humano, no err.message crudo', async () => {
    h.intent = Promise.reject(new Error('PGRST301 JWT expired')) as unknown as Record<string, unknown>;
    render(<PaymentModal tierSlug="starter" tierNombre="Starter" precio={650} onClose={vi.fn()} onPagado={vi.fn()} />);
    expect(await screen.findByText(/No pudimos abrir el pago/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PGRST|JWT/);
    h.intent = { clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago' };
  });
});
