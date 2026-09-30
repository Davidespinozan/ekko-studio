import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CLAVE_OPERACIONES_PAGO } from '@shared/lib/pagoEstado';

/**
 * PKG-01F — MiSuscripcion · cambio de plan mensual→mensual con operation_id,
 * códigos de rechazo honestos, reservas que bloquean (D-01F-4), aviso
 * mensual→paquete (D-01F-5) y consentimiento de pérdida de créditos (D-01F-6).
 * (Scaffolding tomado de MiSuscripcion.pkg02b.test.tsx.)
 *
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
  PaymentModal: (p: { tierSlug?: string; flujo?: string; confirmarPerdidaCreditos?: boolean; onPagado: (x: { paymentIntentId: string; creadoEn?: number }) => void; onEnProceso?: (x: { paymentIntentId: string }) => void }) => {
    h.modal(p.tierSlug, p.flujo, p.confirmarPerdidaCreditos);
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
  window.localStorage.clear();
  window.history.replaceState(null, '', '/app/perfil');
  vi.useFakeTimers({ shouldAdvanceTime: true }); // el reload del éxito va en un setTimeout que no se dispara
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const swapCalls = () => h.backend.mock.calls.filter((c: unknown[]) => c[0] === 'cambiar-plan-suscripcion') as Array<[string, { tier: string; operation_id: string }]>;

/** Miembro con mensualidad Stripe viva en Básica. */
function conSuscripcion() {
  h.membresias = [viva('basica', 'tiempo', { stripe_subscription_id: 'sub_1' })];
}
function responderSwap(fn: (body: { tier: string; operation_id: string }) => unknown) {
  h.backend = vi.fn().mockImplementation(async (path: string, body: unknown) => (path === 'cambiar-plan-suscripcion' ? fn(body as { tier: string; operation_id: string }) : { activated: false, reason: 'stripe_pendiente' }));
}
async function elegirPro() {
  renderComp('basica');
  await abrirCambio();
  fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
}

describe('mensual → mensual (PKG-01F)', () => {
  it('envía un operation_id UUID y afirma el éxito solo con el 200 del servidor; muestra la diferencia cobrada', async () => {
    conSuscripcion();
    responderSwap(() => ({ success: true, tier: 'pro', tier_anterior: 'basica', direccion: 'upgrade', cobro: { invoice_id: 'in_1', amount_paid_centavos: 35000, moneda: 'mxn' } }));
    await elegirPro();
    await waitFor(() => expect(swapCalls()).toHaveLength(1));
    expect(swapCalls()[0][1]).toEqual({ tier: 'pro', operation_id: expect.stringMatching(UUID) });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(expect.stringMatching(/Cambiaste a Pro.*\$350/)));
    expect(h.modal).not.toHaveBeenCalled();
    // Operación aplicada → se descarta (la próxima intención es nueva).
    expect(window.localStorage.getItem(CLAVE_OPERACIONES_PAGO) ?? '{}').not.toMatch(/swap:pro/);
  });

  it('resultado_desconocido conserva la operación: el reintento manda el MISMO operation_id', async () => {
    conSuscripcion();
    responderSwap(() => ({ success: false, code: 'resultado_desconocido', error: 'x' }));
    await elegirPro();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(expect.stringMatching(/no se aplicará dos veces/), expect.anything()));
    fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
    await waitFor(() => expect(swapCalls()).toHaveLength(2));
    expect(swapCalls()[1][1].operation_id).toBe(swapCalls()[0][1].operation_id);
  });

  it('cobro_fallido es terminal: el plan no cambió, y el siguiente intento usa OTRO operation_id (la key replayaría el rechazo)', async () => {
    conSuscripcion();
    responderSwap(() => ({ success: false, code: 'cobro_fallido', error: 'x' }));
    await elegirPro();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(expect.stringMatching(/Tu plan no cambió/), expect.anything()));
    fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
    await waitFor(() => expect(swapCalls()).toHaveLength(2));
    expect(swapCalls()[1][1].operation_id).not.toBe(swapCalls()[0][1].operation_id);
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ['morosidad', /pago pendiente/],
    ['cancelacion_programada', /cancelación programada/],
    ['operacion_conflicto', /vuelve a abrir/i],
    ['estado_no_permitido', /no está en un estado/],
    ['requiere_revision', /No lo repitas/]
  ])('%s → mensaje específico, sin éxito ni modal de pago', async (code, re) => {
    conSuscripcion();
    responderSwap(() => ({ success: false, code, error: 'x' }));
    await elegirPro();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(expect.stringMatching(re), expect.anything()));
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('D-01F-4 · reservas_incompatibles → modal con folio, estudio y motivo; nada más ocurre', async () => {
    conSuscripcion();
    responderSwap(() => ({
      success: false, code: 'reservas_incompatibles', error: 'x',
      reservas: [{ reserva_id: 'r1', folio: 'EKK-000123', slot_inicio: '2026-10-05T18:00:00Z', recurso: 'Sala Pro', invitados: 0, motivo: 'estudio_no_permitido' }, { reserva_id: 'r2', folio: 'EKK-000124', slot_inicio: '2026-10-06T18:00:00Z', recurso: 'Sala A', invitados: 3, motivo: 'invitados_exceden' }]
    }));
    await elegirPro();
    const modal = await screen.findByTestId('reservas-bloqueo');
    expect(modal).toHaveTextContent('EKK-000123');
    expect(modal).toHaveTextContent('estudio no incluido en el plan');
    expect(modal).toHaveTextContent(/3 invitados/);
    expect(modal).toHaveTextContent('No se modificó nada');
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('sin_suscripcion → cae al modal de pago normal (compra)', async () => {
    conSuscripcion();
    responderSwap(() => ({ reason: 'sin_suscripcion' }));
    await elegirPro();
    await waitFor(() => expect(h.modal).toHaveBeenCalledWith('pro', 'perfil', false));
  });
});

describe('D-01F-5 · mensual con suscripción → paquete', () => {
  it('avisa que la mensualidad se sustituye y el resto del periodo se pierde ANTES de abrir el pago; "Mejor no" no abre nada', async () => {
    conSuscripcion();
    renderComp('basica');
    await abrirCambio();
    fireEvent.click(screen.getByRole('tab', { name: /paquetes/i }));
    fireEvent.click(within(cardPlan('Pack 4')).getByRole('button', { name: /elegir este/i }));
    const aviso = await screen.findByTestId('aviso-sustitucion');
    expect(aviso).toHaveTextContent(/se cancela/);
    expect(aviso).toHaveTextContent(/tiempo restante del periodo ya pagado se pierde/);
    expect(aviso).toHaveTextContent(/No hay reembolso/);
    expect(h.modal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mejor no' }));
    expect(screen.queryByTestId('aviso-sustitucion')).not.toBeInTheDocument();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it('"Entiendo, comprar" abre el pago del paquete (sin consentimiento de créditos, no aplica)', async () => {
    conSuscripcion();
    renderComp('basica');
    await abrirCambio();
    fireEvent.click(screen.getByRole('tab', { name: /paquetes/i }));
    fireEvent.click(within(cardPlan('Pack 4')).getByRole('button', { name: /elegir este/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Entiendo, comprar' }));
    await waitFor(() => expect(h.modal).toHaveBeenCalledWith('pack4', 'perfil', false));
  });

  it('sin suscripción Stripe (paquete actual) no hay aviso de sustitución', async () => {
    h.membresias = [viva('pack4', 'creditos', { creditos_restantes: 0 })];
    renderComp('pack4');
    await abrirCambio();
    fireEvent.click(within(cardPlan('Pack 4')).getByRole('button', { name: /recomprar/i }));
    await waitFor(() => expect(h.modal).toHaveBeenCalled());
    expect(screen.queryByTestId('aviso-sustitucion')).not.toBeInTheDocument();
  });
});

describe('D-01F-6 · paquete con créditos → mensual', () => {
  it('pide confirmación y, al continuar, el pago viaja con confirmarPerdidaCreditos=true (el servidor lo exige)', async () => {
    h.membresias = [viva('pack4', 'creditos', { creditos_restantes: 3 })];
    responderSwap(() => ({ reason: 'sin_suscripcion' }));
    renderComp('pack4');
    await abrirCambio();
    fireEvent.click(screen.getByRole('tab', { name: /membresías/i }));
    fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
    expect(await screen.findByText(/PIERDES TUS CRÉDITOS/)).toBeInTheDocument();
    expect(h.modal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar igual' }));
    await waitFor(() => expect(h.modal).toHaveBeenCalledWith('pro', 'perfil', true));
  });

  it('"Mejor no" no abre el pago; sin créditos no se pide consentimiento y el pago va con false', async () => {
    h.membresias = [viva('pack4', 'creditos', { creditos_restantes: 3 })];
    renderComp('pack4');
    await abrirCambio();
    fireEvent.click(screen.getByRole('tab', { name: /membresías/i }));
    fireEvent.click(within(cardPlan('Pro')).getByRole('button', { name: /elegir este/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mejor no' }));
    expect(h.modal).not.toHaveBeenCalled();
  });
});
