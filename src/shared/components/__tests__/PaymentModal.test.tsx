import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, configure } from '@testing-library/react';

// PKG-01C: preparar el pago ahora obtiene primero el operation_id (localStorage;
// sin Web Locks en jsdom usa el respaldo con una espera corta). Bajo carga de CI
// el primer render puede pasar de 1 s: se amplía la espera de los find*/waitFor
// de ESTE archivo. No cambia ninguna aserción.
configure({ asyncUtilTimeout: 5000 });

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
    intent: { clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago' } as Record<string, unknown>,
    // PKG-01C: captura (tier, operation_id) de cada preparación.
    crear: vi.fn()
  };
});

vi.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve({}) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: (p: { children: React.ReactNode }) => <>{p.children}</>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: (...a: unknown[]) => h.confirmPayment(...a) }),
  useElements: () => ({ submit: (...a: unknown[]) => h.submit(...a) })
}));
vi.mock('@shared/lib/checkout', () => ({ crearPagoIntent: (...a: unknown[]) => { h.crear(...a); return Promise.resolve(h.intent); } }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: { id: 'u-1', nombre: 'Ana' } }) }));

import { PaymentModal } from '../PaymentModal';
import { CLAVE_PAGO_PENDIENTE, CLAVE_OPERACIONES_PAGO, MENSAJE_PAGO, operacionPagoActual } from '@shared/lib/pagoEstado';

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
    // El fallo se lanza AL LLAMAR (no una promesa pre-rechazada: con PKG-01C el
    // modal obtiene antes el operation_id y esa promesa quedaría sin manejador).
    h.crear.mockImplementationOnce(() => { throw new Error('PGRST301 JWT expired'); });
    render(<PaymentModal tierSlug="starter" tierNombre="Starter" precio={650} onClose={vi.fn()} onPagado={vi.fn()} />);
    expect(await screen.findByText(/No pudimos abrir el pago/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PGRST|JWT/);
  });
});

// ── PKG-01C · operación estable al PREPARAR el pago ──────────────────────────
describe('PaymentModal · operation_id (PKG-01C)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const abrir = (props: Partial<React.ComponentProps<typeof PaymentModal>> = {}) => {
    const onPagado = vi.fn();
    const onEnProceso = vi.fn();
    const r = render(<PaymentModal tierSlug="pack4" tierNombre="Pack 4" precio={850} esPaquete flujo="perfil" onClose={vi.fn()} onPagado={onPagado} onEnProceso={onEnProceso} {...props} />);
    return { onPagado, onEnProceso, ...r };
  };

  beforeEach(() => {
    h.crear.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    h.intent = { clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago' };
  });

  it('2 · envía un operation_id y "Reintentar" reutiliza EL MISMO (misma intención)', async () => {
    h.intent = { estado: 'resultado_desconocido', operationId: 'x' };
    abrir();
    expect(await screen.findByText(MENSAJE_PAGO.prepararDesconocido)).toBeInTheDocument();
    const op1 = h.crear.mock.calls[0][1] as string;
    expect(op1).toMatch(UUID);
    expect(h.crear.mock.calls[0][0]).toBe('pack4');
    h.intent = { estado: 'reutilizable', clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago', monto: 85000 };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Pagar ahora' })).toBeInTheDocument();
    expect(h.crear.mock.calls[1][1]).toBe(op1);
  });

  it('3 · reabrir el modal (misma intención, p. ej. tras refresh) reutiliza el operation_id persistido', async () => {
    const a = abrir();
    await screen.findByRole('button', { name: 'Pagar ahora' });
    a.unmount();
    abrir();
    await screen.findByRole('button', { name: 'Pagar ahora' });
    expect(h.crear.mock.calls[1][1]).toBe(h.crear.mock.calls[0][1]);
    expect(window.localStorage.getItem(CLAVE_OPERACIONES_PAGO)).toContain('u-1|paquete:pack4');
  });

  it('red / 5xx al preparar → "Reintentar" con la MISMA operación (nunca un cobro doble)', async () => {
    h.crear.mockImplementationOnce(() => { throw new Error('HTTP 502'); });
    abrir();
    expect(await screen.findByText(MENSAJE_PAGO.prepararReintentable)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('button', { name: 'Pagar ahora' });
    expect(h.crear.mock.calls[1][1]).toBe(h.crear.mock.calls[0][1]);
  });

  it('reemplazable → la operación se descarta y "Preparar el pago de nuevo" usa un operation_id NUEVO', async () => {
    h.intent = { estado: 'reemplazable', operationId: 'x', objetoId: 'pi_1' };
    abrir();
    expect(await screen.findByText(MENSAJE_PAGO.intentoReemplazable)).toBeInTheDocument();
    const op1 = h.crear.mock.calls[0][1];
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBeNull();
    h.intent = { estado: 'reutilizable', clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'pago' };
    fireEvent.click(screen.getByRole('button', { name: 'Preparar el pago de nuevo' }));
    await screen.findByRole('button', { name: 'Pagar ahora' });
    expect(h.crear.mock.calls[1][1]).not.toBe(op1);
  });

  it('ya_pagado → onPagado con el objeto y su fecha (02B observa el derecho); la operación se cierra', async () => {
    h.intent = { estado: 'ya_pagado', operationId: 'x', objetoId: 'pi_7', creadoEn: 1_700_000_000_000 };
    const { onPagado } = abrir();
    await waitFor(() => expect(onPagado).toHaveBeenCalledWith({ paymentIntentId: 'pi_7', creadoEn: 1_700_000_000_000 }));
    expect(JSON.parse(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!)).toMatchObject({ estado: 'confirmado', paymentIntentId: 'pi_7' });
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pagar ahora' })).not.toBeInTheDocument();
  });

  it('en_proceso → onEnProceso, sin formulario ni reintento; la operación se CONSERVA', async () => {
    h.intent = { estado: 'en_proceso', operationId: 'x', objetoId: 'pi_8' };
    const { onEnProceso } = abrir();
    await waitFor(() => expect(onEnProceso).toHaveBeenCalledWith({ paymentIntentId: 'pi_8' }));
    expect(screen.queryByRole('button', { name: /Pagar ahora|Reintentar/ })).not.toBeInTheDocument();
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toMatch(UUID);
  });

  it('requiere_revision → "No lo repitas", sin botón de pago ni de reintento', async () => {
    h.intent = { estado: 'requiere_revision', operationId: 'x' };
    abrir();
    expect(await screen.findByText(MENSAJE_PAGO.requiereRevision)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pagar ahora|Reintentar|Preparar/ })).not.toBeInTheDocument();
  });

  it('reutilizable con importe distinto al mostrado (intento previo a un cambio de precio) → se dice el importe REAL', async () => {
    h.intent = { estado: 'reutilizable', clientSecret: 'cs_ficticio', account: 'acct_test', modo: 'suscripcion', monto: 85000 };
    abrir({ precio: 990 });
    expect(await screen.findByTestId('monto-real')).toHaveTextContent('$850');
  });

  it('confirmación succeeded → la operación queda marcada confirmada (se cierra cuando 02B observa el derecho)', async () => {
    h.confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_ok', status: 'succeeded' } });
    const { onPagado } = await montarYPagar({ tierSlug: 'pack4' });
    await waitFor(() => expect(onPagado).toHaveBeenCalled());
    const mapa = JSON.parse(window.localStorage.getItem(CLAVE_OPERACIONES_PAGO)!);
    expect(mapa['u-1|paquete:pack4']).toMatchObject({ confirmada: true });
  });
});
