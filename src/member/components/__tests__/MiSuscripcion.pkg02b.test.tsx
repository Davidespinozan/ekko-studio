import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CLAVE_PAGO_PENDIENTE, MENSAJE_PAGO } from '@shared/lib/pagoEstado';

/**
 * PKG-02B — MiSuscripcion:
 *  · C04: PAGO CONFIRMADO ≠ PLAN ACTIVO. Se observa la evidencia ESPECÍFICA (membresía
 *    viva del plan pagado creada tras el pago); "Volver a comprobar" solo lee.
 *  · C28 (visual): "Actual" se deriva de la membresía VIVA, no de usuarios.membresia_tier;
 *    el mismo paquete agotado se "Recompra", no se "Elige".
 */

const h = vi.hoisted(() => ({
  tiers: [] as unknown[],
  membresias: [] as unknown[],
  observar: vi.fn(),
  refreshUsuario: vi.fn(),
  modal: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  backend: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => {
  function builderFor(table: string) {
    const result = table === 'tiers' ? { data: h.tiers, error: null } : table === 'membresias' ? { data: h.membresias, error: null } : { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b;
    b.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
    return b;
  }
  return { supabase: { from: (t: string) => builderFor(t) } };
});
vi.mock('@shared/lib/backend', () => ({ backendPost: (path: string, body: unknown) => h.backend(path, body) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ refreshUsuario: (...a: unknown[]) => h.refreshUsuario(...a) }) }));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => h.toast }));
vi.mock('@shared/lib/observarActivacion', () => ({ observarActivacion: (...a: unknown[]) => h.observar(...a) }));
vi.mock('@shared/components/PaymentModal', () => ({
  PaymentModal: (p: { tierSlug?: string; flujo?: string; onPagado: (x: { paymentIntentId: string; creadoEn?: number }) => void; onEnProceso?: (x: { paymentIntentId: string }) => void }) => {
    h.modal(p.tierSlug, p.flujo);
    return (
      <div>
        <button onClick={() => p.onPagado({ paymentIntentId: 'pi_s' })}>SIMULAR_SUCCEEDED</button>
        <button onClick={() => p.onEnProceso?.({ paymentIntentId: 'pi_s' })}>SIMULAR_PROCESSING</button>
        {/* PKG-01C: la MISMA operación ya estaba pagada (creada hace 1 h). */}
        <button onClick={() => p.onPagado({ paymentIntentId: 'pi_s', creadoEn: Date.now() - 3_600_000 })}>SIMULAR_YA_PAGADO</button>
      </div>
    );
  }
}));

import { MiSuscripcion } from '../MiSuscripcion';

const TIERS = [
  { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: [], descripcion: null, tipo: 'tiempo', clases_incluidas: null, duracion_dias: null, activo: true, en_venta: true },
  { slug: 'pro', nombre: 'Pro', precio_centavos: 120000, beneficios: [], descripcion: null, tipo: 'tiempo', clases_incluidas: null, duracion_dias: null, activo: true, en_venta: true },
  { slug: 'pack4', nombre: 'Pack 4', precio_centavos: 90000, beneficios: [], descripcion: null, tipo: 'creditos', clases_incluidas: 4, duracion_dias: 60, activo: true, en_venta: true }
];
const viva = (slug: string, tipo: string, extra: Record<string, unknown> = {}) => ({
  status: 'activa', stripe_subscription_id: null, cancel_at_period_end: false, periodo_actual_fin: '2099-01-01T00:00:00Z',
  creditos_restantes: tipo === 'creditos' ? 2 : null, created_at: '2026-01-01T00:00:00Z', tier: { slug, tipo }, ...extra
});

const renderComp = (tierSlug: string | null = 'basica') => render(<MiSuscripcion usuarioId="u-1" tierSlug={tierSlug} status="activa" />);

/** Tarjeta del plan dentro del modal "Cambiar de plan" (el nombre también aparece en la cabecera). */
function cardPlan(nombre: string): HTMLElement {
  const card = screen.getAllByText(nombre).map((e) => e.closest('.ek-card--cream')).find(Boolean);
  if (!card) throw new Error(`No hay tarjeta de plan para ${nombre}`);
  return card as HTMLElement;
}

async function abrirCambio() {
  fireEvent.click(await screen.findByRole('button', { name: /cambiar de plan|ver planes/i }));
  return screen.findByText('CAMBIAR DE PLAN');
}

beforeEach(() => {
  h.tiers = TIERS;
  h.membresias = [];
  h.observar.mockReset();
  h.refreshUsuario.mockReset().mockResolvedValue(undefined);
  h.modal.mockReset();
  for (const f of Object.values(h.toast)) f.mockReset();
  h.backend = vi.fn().mockResolvedValue({ activated: false, reason: 'stripe_pendiente' });
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/app/perfil');
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('MiSuscripcion · activación observada (PKG-02B · C04)', () => {
  async function pagarPro() {
    renderComp(null);
    await abrirCambio();
    // Sin suscripción Stripe el cambio se paga in-app: PaymentModal (mock).
    fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
    await screen.findByText('SIMULAR_SUCCEEDED');
    expect(h.modal).toHaveBeenLastCalledWith('pro', 'perfil');
  }

  it('9 · succeeded + membresía del plan pagado observada → "Tu plan ya está activo.", refresh y sin pendiente', async () => {
    h.observar.mockResolvedValue({ resultado: 'observada', dato: viva('pro', 'tiempo', { created_at: new Date().toISOString() }) });
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Tu plan ya está activo.'));
    expect(h.refreshUsuario).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)).toBeNull();
    expect(screen.queryByTestId('activacion-pendiente')).not.toBeInTheDocument();
    expect(await screen.findByText('Pro')).toBeInTheDocument();
  });

  it('10 · la evidencia es ESPECÍFICA: mismo plan y creada tras el pago; otro plan, fila vieja o sin fecha no activan', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: null });
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    const opts = h.observar.mock.calls[0][0] as { listo: (m: Record<string, unknown>) => boolean };
    const ahora = new Date().toISOString();
    expect(opts.listo({ tier: { slug: 'pro' }, created_at: ahora })).toBe(true);
    expect(opts.listo({ tier: { slug: 'basica' }, created_at: ahora })).toBe(false); // otro plan (p. ej. la vieja)
    expect(opts.listo({ tier: { slug: 'pro' }, created_at: '2020-01-01T00:00:00Z' })).toBe(false); // fila anterior al pago
    expect(opts.listo({ tier: { slug: 'pro' }, created_at: null })).toBe(false);
  });

  it('11 · no observada → tarjeta "PAGO RECIBIDO" + "Volver a comprobar" (solo lee); "Cambiar de plan" oculto; sin toast de éxito', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: null });
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    const card = await screen.findByTestId('activacion-pendiente');
    expect(within(card).getByText('PAGO RECIBIDO')).toBeInTheDocument();
    expect(within(card).getByText(MENSAJE_PAGO.activacionTarda)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cambiar de plan|ver planes/i })).not.toBeInTheDocument();
    expect(h.toast.success).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Volver a comprobar' }));
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(2));
    expect(h.modal).toHaveBeenCalledTimes(1); // no se reabrió el pago
    expect(screen.queryByText('SIMULAR_SUCCEEDED')).not.toBeInTheDocument();
  });

  it('error de lectura → "No pudimos comprobar la activación", no "activo" ni "fallido"', async () => {
    h.observar.mockResolvedValue({ resultado: 'error' });
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_SUCCEEDED'));
    expect(await screen.findByText(MENSAJE_PAGO.comprobacionFallo)).toBeInTheDocument();
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it('12 · processing → "PAGO EN PROCESO" sin "Volver a comprobar" ni observación; pendiente persistido sin PII', async () => {
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_PROCESSING'));
    const card = await screen.findByTestId('activacion-pendiente');
    expect(within(card).getByText('PAGO EN PROCESO')).toBeInTheDocument();
    expect(within(card).getByText(MENSAJE_PAGO.pagoEnProcesoPersistido)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Volver a comprobar' })).not.toBeInTheDocument();
    expect(h.observar).not.toHaveBeenCalled();
    const raw = window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!;
    expect(JSON.parse(raw)).toEqual({ flujo: 'perfil', paymentIntentId: 'pi_s', estado: 'en_proceso', ts: expect.any(Number), contexto: { slug: 'pro' } });
  });

  it('PKG-01C · ya_pagado de una operación anterior → la evidencia se busca desde el pago ORIGINAL (no desde ahora)', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: null });
    await pagarPro();
    fireEvent.click(screen.getByText('SIMULAR_YA_PAGADO'));
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    const opts = h.observar.mock.calls[0][0] as { listo: (m: Record<string, unknown>) => boolean };
    // Membresía creada hace 50 min (después del pago original, antes de "ahora").
    expect(opts.listo({ tier: { slug: 'pro' }, created_at: new Date(Date.now() - 3_000_000).toISOString() })).toBe(true);
  });

  it('?suscripcion=ok (success_url del Checkout) NO afirma: solo observa', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: null });
    window.history.replaceState(null, '', '/app/perfil?suscripcion=ok');
    renderComp('basica');
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('activacion-pendiente')).toBeInTheDocument();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('pendiente confirmado persistido (refresh) → observa el plan guardado en el contexto', async () => {
    h.observar.mockResolvedValue({ resultado: 'no_observada', ultimo: null });
    window.sessionStorage.setItem(CLAVE_PAGO_PENDIENTE, JSON.stringify({ flujo: 'perfil', paymentIntentId: 'pi_p', estado: 'confirmado', ts: Date.now() - 5000, contexto: { slug: 'pro' } }));
    renderComp('basica');
    await waitFor(() => expect(h.observar).toHaveBeenCalledTimes(1));
    const opts = h.observar.mock.calls[0][0] as { listo: (m: Record<string, unknown>) => boolean };
    expect(opts.listo({ tier: { slug: 'basica' }, created_at: new Date().toISOString() })).toBe(false);
    expect(opts.listo({ tier: { slug: 'pro' }, created_at: new Date().toISOString() })).toBe(true);
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('retorno de redirect fallido → "El pago no se completó…"; no observa ni afirma', async () => {
    window.history.replaceState(null, '', '/app/perfil?pago=perfil&payment_intent=pi_x&redirect_status=requires_payment_method');
    renderComp('basica');
    expect(await screen.findByText(MENSAJE_PAGO.noCompletado)).toBeInTheDocument();
    expect(h.observar).not.toHaveBeenCalled();
    expect(screen.queryByTestId('activacion-pendiente')).not.toBeInTheDocument();
  });
});

describe('MiSuscripcion · plan actual desde la membresía viva (PKG-02B · C28)', () => {
  it('28 · usuarios.membresia_tier desactualizado: el plan mostrado y la marca "Actual" salen de la membresía VIVA', async () => {
    h.membresias = [viva('basica', 'tiempo')];
    renderComp('pro'); // prop (usuarios.membresia_tier) dice "pro", la membresía viva es Básica
    expect(await screen.findByRole('heading', { name: 'Básica' })).toBeInTheDocument();
    await abrirCambio();
    const cardBasica = cardPlan('Básica');
    expect(within(cardBasica).getByText('Actual')).toBeInTheDocument();
    expect(within(cardBasica).queryByRole('button')).not.toBeInTheDocument();
    const cardPro = cardPlan('Pro');
    expect(within(cardPro).queryByText('Actual')).not.toBeInTheDocument();
    expect(within(cardPro).getByRole('button', { name: /elegir este/i })).toBeInTheDocument();
  });

  it('membresía cancelada del plan que dice usuarios.membresia_tier → ningún plan es "Actual"', async () => {
    h.membresias = [{ ...viva('pro', 'tiempo'), status: 'cancelada' }];
    renderComp('pro');
    await abrirCambio();
    expect(screen.queryByText('Actual')).not.toBeInTheDocument();
  });

  it('29 · el mismo paquete con créditos agotados se "Recompra" (abre el pago directo), no es "Actual" ni "Elegir este"', async () => {
    h.membresias = [viva('pack4', 'creditos', { creditos_restantes: 0 })];
    renderComp('pack4');
    await abrirCambio();
    const card = cardPlan('Pack 4');
    expect(within(card).queryByText('Actual')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: /recomprar/i }));
    await screen.findByText('SIMULAR_SUCCEEDED');
    expect(h.modal).toHaveBeenCalledWith('pack4', 'perfil');
    expect(h.backend).not.toHaveBeenCalledWith('cambiar-plan-suscripcion', expect.anything());
  });

  it('el mismo paquete CON créditos es "Actual" y no ofrece nada', async () => {
    h.membresias = [viva('pack4', 'creditos', { creditos_restantes: 3 })];
    renderComp('pack4');
    await abrirCambio();
    const card = cardPlan('Pack 4');
    expect(within(card).getByText('Actual')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });
});
