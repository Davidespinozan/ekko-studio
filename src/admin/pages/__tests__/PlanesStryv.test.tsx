import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * EKKO-149 · /admin/stryv: STRYV Care y STRYV Grow, cada uno con su estado, precio,
 * lo que incluye, activar (Checkout de Stripe), portal y recibos; el regreso de
 * Stripe se reconoce una vez, para el plan que corresponde, y la URL se limpia.
 * Un fallo al consultar no se muestra como "sin activar".
 */

const h = vi.hoisted(() => ({ irA: vi.fn() }));
vi.mock('../../lib/stryvCareService', async (orig) => ({
  ...(await orig<typeof import('../../lib/stryvCareService')>()),
  irA: (u: string) => h.irA(u)
}));

import PlanesStryv from '../PlanesStryv';
import { planDeRegreso, regresoDeStripe, type ClientePlanes, type PlanStryv } from '../../lib/stryvCareService';

type Estado = Record<string, unknown> | { ok: false; message: string };
const cliente = (porPlan: Partial<Record<PlanStryv, Estado>>, url = 'https://checkout.stripe.test/x'): ClientePlanes =>
  ({
    estado: vi.fn(async (plan: PlanStryv) => {
      const e = porPlan[plan] ?? { estado: 'no_disponible' };
      return 'ok' in e && e.ok === false ? e : { ok: true as const, data: e };
    }),
    activar: vi.fn(async () => ({ ok: true as const, data: { url } })),
    portal: vi.fn(async () => ({ ok: true as const, data: { url } }))
  }) as unknown as ClientePlanes;

function Probe() {
  const l = useLocation();
  return <span data-testid="probe-search">{l.search}</span>;
}

const montar = (c: ClientePlanes, ruta = '/admin/stryv') =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route path="/admin/stryv" element={<><PlanesStryv cliente={c} /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );

const INACTIVO_CARE = { plan: 'care', estado: 'inactivo', monto_centavos: 250000, puede_activar: true };
const INACTIVO_GROW = { plan: 'grow', estado: 'inactivo', monto_centavos: 650000, puede_activar: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Planes STRYV (EKKO-149)', () => {
  it('muestra los dos planes con su precio, lo que incluye y su botón; Care con infraestructura, Grow con los videos', async () => {
    const c = cliente({ care: INACTIVO_CARE, grow: INACTIVO_GROW });
    montar(c);
    const care = within(await screen.findByTestId('plan-care'));
    const grow = within(screen.getByTestId('plan-grow'));
    expect(await care.findByText('$2,500')).toBeInTheDocument();
    expect(care.getByTestId('care-estado').textContent).toBe('Sin activar');
    expect(care.getByText(/Servidores, base de datos, dominio y certificados de seguridad/)).toBeInTheDocument();
    expect(care.getByText(/Soporte directo con STRYV/)).toBeInTheDocument();
    expect(care.getByTestId('care-activar')).toHaveTextContent('Activar STRYV Care');

    expect(await grow.findByText('$6,500')).toBeInTheDocument();
    expect(grow.getByText(/15 videos al mes producidos con IA/)).toBeInTheDocument();
    expect(grow.getByText(/Escenas de tus propios estudios, con voz y música/)).toBeInTheDocument();
    expect(grow.getByText(/Cada video diseñado para llevar gente a reservar en tu app/)).toBeInTheDocument();
    expect(grow.getByText(/Listos para publicar en Instagram, TikTok y Facebook/)).toBeInTheDocument();
    expect(grow.getByTestId('grow-activar')).toHaveTextContent('Activar STRYV Grow');

    // Variante de Renovacell (precio preferente + nota de servicios externos): NO aplica aquí.
    expect(screen.queryByText(/\$4,000/)).toBeNull();
    expect(screen.queryByText(/los contrata y paga/)).toBeNull();
    expect(c.estado).toHaveBeenCalledWith('care');
    expect(c.estado).toHaveBeenCalledWith('grow');
  });

  it('Activar de cada plan pide el checkout DE ESE plan y abre Stripe', async () => {
    const c = cliente({ care: INACTIVO_CARE, grow: INACTIVO_GROW });
    montar(c);
    fireEvent.click(await screen.findByTestId('grow-activar'));
    await waitFor(() => expect(h.irA).toHaveBeenCalledWith('https://checkout.stripe.test/x'));
    expect(c.activar).toHaveBeenCalledWith('grow');
    expect(c.activar).not.toHaveBeenCalledWith('care');
  });

  it('Care activo y Grow sin activar conviven: cada tarjeta con su estado, tarjeta, portal y recibos', async () => {
    const c = cliente({
      care: { plan: 'care', estado: 'active', monto_centavos: 250000, proximo_cobro: 1798761600, tarjeta: { marca: 'visa', last4: '4242' }, recibos: [{ fecha: 1796083200, monto_centavos: 250000, estado: 'paid', url: 'https://inv/1' }] },
      grow: INACTIVO_GROW
    });
    montar(c);
    const care = within(await screen.findByTestId('plan-care'));
    expect(await care.findByText('Activo')).toBeInTheDocument();
    expect(care.getByText('Próximo cobro')).toBeInTheDocument();
    expect(care.getByText('VISA ···· 4242')).toBeInTheDocument();
    expect(care.getByText('Pagado')).toBeInTheDocument();
    expect(care.getByRole('link', { name: /^Ver/ })).toHaveAttribute('href', 'https://inv/1');
    expect(care.queryByTestId('care-activar')).toBeNull();
    fireEvent.click(care.getByTestId('care-portal'));
    await waitFor(() => expect(c.portal).toHaveBeenCalledWith('care'));

    const grow = within(screen.getByTestId('plan-grow'));
    expect(await grow.findByTestId('grow-activar')).toBeInTheDocument();
    expect(grow.queryByText('Activo')).toBeNull();
  });

  it('cancelación programada: dice "Termina el" en vez de próximo cobro', async () => {
    montar(cliente({ care: { plan: 'care', estado: 'active', monto_centavos: 250000, termina: 1798761600, proximo_cobro: null, tarjeta: null, recibos: [] } }));
    expect(await screen.findByText('Termina el')).toBeInTheDocument();
    expect(screen.queryByText('Próximo cobro')).toBeNull();
  });

  it('sin llave de Stripe: "Aún no está disponible" en cada plan, sin precio ni botón de activar', async () => {
    montar(cliente({ care: { estado: 'no_disponible' }, grow: { estado: 'no_disponible' } }));
    expect(await screen.findAllByText(/Aún no está disponible/)).toHaveLength(2);
    expect(screen.queryByTestId('care-activar')).toBeNull();
    expect(screen.queryByTestId('grow-activar')).toBeNull();
    expect(screen.queryByText(/MXN al mes/)).toBeNull();
  });

  it('regreso de Stripe (?stryv=ok&plan=grow): confirma una vez EN GROW y limpia la URL', async () => {
    montar(cliente({ care: INACTIVO_CARE, grow: { plan: 'grow', estado: 'active', monto_centavos: 650000, proximo_cobro: 1798761600, tarjeta: null, recibos: [] } }), '/admin/stryv?stryv=ok&plan=grow');
    expect(await screen.findByTestId('grow-regreso')).toHaveTextContent('STRYV Grow activado. ¡Gracias!');
    expect(screen.queryByTestId('care-regreso')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('probe-search').textContent).toBe(''));
  });

  it('?stryv=cancel: no afirma nada, solo vuelve a mostrar los planes', async () => {
    montar(cliente({ care: INACTIVO_CARE, grow: INACTIVO_GROW }), '/admin/stryv?stryv=cancel&plan=care');
    expect(await screen.findByTestId('care-activar')).toBeInTheDocument();
    expect(screen.queryByTestId('care-regreso')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('probe-search').textContent).toBe(''));
  });

  it('fallo al consultar un plan: error con Reintentar en ESA tarjeta, nunca "Sin activar"; el otro plan sigue', async () => {
    const c = cliente({ care: { ok: false, message: 'Tu sesión expiró. Cierra sesión y vuelve a entrar.' }, grow: INACTIVO_GROW });
    montar(c);
    const care = within(await screen.findByTestId('plan-care'));
    expect(await care.findByRole('alert')).toHaveTextContent('No pudimos consultar STRYV Care. Tu sesión expiró.');
    expect(care.queryByTestId('care-estado')).toBeNull();
    expect(care.queryByTestId('care-activar')).toBeNull();
    expect(await screen.findByTestId('grow-activar')).toBeInTheDocument();
    fireEvent.click(care.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(c.estado).toHaveBeenCalledTimes(3));
    expect(c.estado).toHaveBeenLastCalledWith('care');
  });

  it('el pie "Operado por STRYV" enlaza a stryvstudio.com en pestaña nueva', async () => {
    montar(cliente({}));
    const a = await screen.findByRole('link', { name: /Operado por STRYV/ });
    expect(a).toHaveAttribute('href', 'https://stryvstudio.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('regresoDeStripe y planDeRegreso reconocen solo sus valores', () => {
    expect(regresoDeStripe('ok')).toBe('ok');
    expect(regresoDeStripe('cancel')).toBe('cancel');
    expect(regresoDeStripe('volver')).toBe('volver');
    expect(regresoDeStripe('otro')).toBeNull();
    expect(regresoDeStripe(null)).toBeNull();
    expect(planDeRegreso('grow')).toBe('grow');
    expect(planDeRegreso('care')).toBe('care');
    expect(planDeRegreso('premium')).toBeNull();
  });
});
