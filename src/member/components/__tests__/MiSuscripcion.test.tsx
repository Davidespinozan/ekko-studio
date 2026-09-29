import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * MiSuscripcion: muestra el plan actual con datos reales del tier, estado
 * vacío de pagos, y permite cambiar de plan IN-APP. El cambio ahora va por
 * Stripe Checkout (función `suscribir-membresia`); sin Stripe responde
 * stripe_pendiente y la UI avisa "acercate a recepción".
 */

const h = vi.hoisted(() => ({
  tiers: [] as unknown[],
  pagos: [] as unknown[],
  membresias: [] as unknown[],
  tiersError: null as unknown,
  backend: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => {
  function builderFor(table: string) {
    const result =
      table === 'tiers' ? (h.tiersError ? { data: null, error: h.tiersError } : { data: h.tiers, error: null })
      : table === 'membresias' ? { data: h.membresias, error: null }
      : { data: h.pagos, error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
    b.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
    return b;
  }
  return { supabase: { from: (t: string) => builderFor(t) } };
});

vi.mock('@shared/lib/backend', () => ({
  backendPost: (path: string, body: unknown) => h.backend(path, body)
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ refreshUsuario: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@shared/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}));

import { MiSuscripcion } from '../MiSuscripcion';

beforeEach(() => {
  h.tiers = [
    { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: ['Acceso diario'], descripcion: null, activo: true, en_venta: true },
    { slug: 'pro', nombre: 'Pro', precio_centavos: 120000, beneficios: ['Todo Básica', 'Estudios pro'], descripcion: null, activo: true, en_venta: true }
  ];
  h.pagos = [];
  h.membresias = [];
  h.tiersError = null;
  // Sin Stripe configurado: el cambio de plan responde stripe_pendiente.
  h.backend = vi.fn().mockResolvedValue({ activated: false, reason: 'stripe_pendiente' });
});

function renderComp(tierSlug: string | null = 'pro') {
  return render(<MiSuscripcion usuarioId="u-1" tierSlug={tierSlug} status="activa" />);
}

describe('MiSuscripcion', () => {
  it('muestra el plan actual con nombre, precio y estado', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument());
    expect(screen.getByText('$1,200')).toBeInTheDocument();
    expect(screen.getByText('Activa')).toBeInTheDocument();
    expect(screen.getByText('Estudios pro')).toBeInTheDocument();
  });

  it('muestra estado vacío de pagos cuando no hay historial', async () => {
    renderComp('pro');
    // El historial ahora viene del backend (stripe-billing-info); el mock no
    // trae pagos → estado vacío.
    await waitFor(() => expect(screen.getByText('Sin pagos todavía')).toBeInTheDocument());
    expect(screen.getByText('Sin tarjeta registrada')).toBeInTheDocument();
  });

  it('cambiar de plan abre el modal de pago propio', async () => {
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Cambiar de plan')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cambiar de plan'));
    await waitFor(() => expect(screen.getByText('CAMBIAR DE PLAN')).toBeInTheDocument());
    // Elegir el plan no-actual (Básica) abre el PaymentModal de EKKO. (PKG-02B/C28:
    // sin membresía VIVA ningún plan es "Actual", así que ambos ofrecen CTA; Básica va primero.)
    fireEvent.click(screen.getAllByText('Elegir este')[0]);
    // Sin VITE_STRIPE_PUBLISHABLE_KEY en test, el modal muestra el estado pendiente.
    await waitFor(() => expect(screen.getByText('PAGO SEGURO')).toBeInTheDocument());
    expect(screen.getByText(/no están configurados/i)).toBeInTheDocument();
  });

  it('muestra el banner de pago vencido cuando la membresía está past_due', async () => {
    h.membresias = [{ status: 'past_due', stripe_subscription_id: 'sub_1', cancel_at_period_end: false, periodo_actual_fin: null }];
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Tu último pago no se procesó')).toBeInTheDocument());
    // Gestión ahora es 100% in-app: actualizar tarjeta + cancelar plan (sin portal).
    expect(screen.getByText('Actualizar tarjeta')).toBeInTheDocument();
    expect(screen.getByText('Cancelar plan')).toBeInTheDocument();
  });

  /**
   * `en_venta=false` = el estudio dejó de VENDER el plan; sus suscriptores lo
   * conservan. Antes la lista se filtraba por en_venta, `planActual` quedaba en
   * null y el suscriptor veía "No tienes un plan activo" SIN botón de cancelar,
   * mientras se le seguía cobrando.
   */
  it('plan retirado de la venta: sigue siendo SU plan, se lo dice, y puede cancelarlo', async () => {
    h.tiers = [
      { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: [], descripcion: null, activo: true, en_venta: true },
      { slug: 'pro', nombre: 'Pro', precio_centavos: 120000, beneficios: [], descripcion: null, activo: true, en_venta: false }
    ];
    h.membresias = [{ status: 'activa', stripe_subscription_id: 'sub_1', cancel_at_period_end: false, periodo_actual_fin: '2099-01-01T00:00:00Z', creditos_restantes: null }];

    renderComp('pro');

    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.queryByText(/No tienes un plan activo/)).not.toBeInTheDocument();
    expect(screen.getByTestId('plan-fuera-de-venta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancelar plan/i })).toBeInTheDocument();
  });

  it('un plan retirado de la venta NO se ofrece al cambiar de plan', async () => {
    h.tiers = [
      { slug: 'basica', nombre: 'Básica', precio_centavos: 85000, beneficios: [], descripcion: null, activo: true, en_venta: true },
      { slug: 'viejo', nombre: 'Plan Viejo', precio_centavos: 50000, beneficios: [], descripcion: null, activo: true, en_venta: false }
    ];
    renderComp('basica');
    fireEvent.click(await screen.findByRole('button', { name: /cambiar|ver planes|elegir/i }));
    await waitFor(() => expect(screen.queryByText('Plan Viejo')).not.toBeInTheDocument());
  });
});

describe('MiSuscripcion · historial con concepto, recibo y reembolsos (A11)', () => {
  it('muestra qué se cobró, el enlace al recibo y "Reembolsado" cuando aplica', async () => {
    h.backend = vi.fn().mockImplementation((path: string) =>
      Promise.resolve(
        path === 'stripe-billing-info'
          ? {
              paymentMethod: null,
              pagos: [
                { id: 'ch_a', monto_centavos: 120000, moneda: 'mxn', fecha: '2026-09-01T12:00:00Z', status: 'succeeded', descripcion: 'Renovación de membresía · Premium', receipt_url: 'https://pay.stripe.com/receipts/abc', reembolsado_centavos: 0 },
                { id: 'ch_b', monto_centavos: 85000, moneda: 'mxn', fecha: '2026-08-01T12:00:00Z', status: 'refunded', descripcion: 'Paquete · 4 horas', receipt_url: null, reembolsado_centavos: 85000 }
              ]
            }
          : { activated: false, reason: 'stripe_pendiente' }
      )
    );
    renderComp('pro');
    await waitFor(() => expect(screen.getByText('Renovación de membresía · Premium')).toBeInTheDocument());
    const recibo = screen.getByRole('link', { name: 'Ver recibo' });
    expect(recibo).toHaveAttribute('href', 'https://pay.stripe.com/receipts/abc');
    expect(recibo).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Paquete · 4 horas')).toBeInTheDocument();
    expect(screen.getByText('Reembolsado')).toBeInTheDocument();
    expect(screen.getByText('Pagado')).toBeInTheDocument();
  });
});

// ── PKG-02A (C02 · F16) ───────────────────────────────────────────────────────
describe('MiSuscripcion · lectura fallida (PKG-02A)', () => {
  it('planes/membresía en ERROR → "No pudimos cargar tu plan." + Reintentar; nunca "No tienes un plan activo" ni acciones', async () => {
    h.tiersError = { message: 'permission denied for table tiers' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderComp('pro');
    expect(await screen.findByText('No pudimos cargar tu plan.')).toBeInTheDocument();
    expect(screen.queryByText(/No tienes un plan activo/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cambiar de plan|cancelar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
  });

  it('success sin membresía → "No tienes un plan activo" (ausencia real)', async () => {
    renderComp(null);
    expect(await screen.findByText(/No tienes un plan activo/)).toBeInTheDocument();
  });
});
