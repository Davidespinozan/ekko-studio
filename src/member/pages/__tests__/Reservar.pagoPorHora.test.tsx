import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * "Pago por hora" en un solo flujo (solicitud del cliente, punto 2): sin plan o sin
 * saldo, tocar una hora ofrece comprar el paquete que alcance y reservarla al pagar.
 */

const h = vi.hoisted(() => ({
  usuario: { id: 'u-1', nombre: 'Ana', membresia_tier: null as string | null, bloqueado_hasta: null, status: 'activo' },
  tiers: [
    { slug: 'sesion-suelta', nombre: 'Sesión suelta', precio_centavos: 25000, tipo: 'hibrido', clases_incluidas: 1, activo: true, en_venta: true },
    { slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, tipo: 'tiempo', clases_incluidas: null, activo: true, en_venta: true }
  ],
  ocupados: [] as unknown[],
  crearReserva: vi.fn(),
  pagoAbierto: vi.fn(),
  // Estables entre renders: si `useTenant` devolviera un objeto nuevo cada vez, el
  // `config` (useMemo sobre tenant.config) cambiaría y la página recargaría los
  // horarios en bucle.
  tenant: { id: 't-1', nombre: 'EKKO', config: { reserva: { anticipacion_min_horas: 0 } } },
  resumen: { resumen: { tier: null, membresia: null }, isLoading: false, error: false, refetch: vi.fn() },
  refreshUsuario: vi.fn(),
  tiersError: null as unknown,
  recursosError: false,
  recargarRecursos: vi.fn()
}));

const RECURSO = {
  id: 'r-1', slug: 'black', nombre: 'Black', activo: true, costo_creditos: 1, tiers_permitidos: [] as string[],
  foto_url: null, tenant_id: 't-1',
  horarios: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((dia) => ({ dia, inicio: '09:00', fin: '22:00' }))
};

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'gte', 'lt']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: null, error: null });
      c.then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(
          tabla === 'tiers' && h.tiersError ? { data: null, error: h.tiersError } : { data: tabla === 'tiers' ? h.tiers : [], error: null }
        ).then(cb);
      return c;
    },
    rpc: () => Promise.resolve({ data: h.ocupados, error: null })
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario, refreshUsuario: h.refreshUsuario }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => h.tenant }));
vi.mock('@member/hooks/useResumenMiembro', () => ({ useResumenMiembro: () => h.resumen }));
vi.mock('../../hooks/useReservas', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useReservas')>()),
  useRecursosDelTenant: () => ({ recursos: h.recursosError ? [] : [RECURSO], isLoading: false, error: h.recursosError, recargar: h.recargarRecursos }),
  fetchReservasDelUsuario: () => Promise.resolve([]),
  crearReserva: (...a: unknown[]) => h.crearReserva(...a)
}));
vi.mock('@shared/components/PaymentModal', () => ({
  PaymentModal: (p: { tierSlug?: string; precio: number; onPagado: () => void }) => {
    h.pagoAbierto(p.tierSlug, p.precio);
    return <button onClick={p.onPagado}>SIMULAR_PAGO_OK</button>;
  }
}));

import Reservar from '../Reservar';

const montar = () =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/app/reservar']}>
        <Reservar />
      </MemoryRouter>
    </ToastProvider>
  );

async function tocarPrimeraHora() {
  const grid = await screen.findByText('Horario');
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^\d{2}:\d{2}$/ }).length).toBeGreaterThan(0));
  const libres = screen.getAllByRole('button', { name: /^\d{2}:\d{2}$/ }).filter((b) => !(b as HTMLButtonElement).disabled);
  fireEvent.click(libres[libres.length - 1]);
  return grid;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.usuario.membresia_tier = null;
  h.resumen.error = false;
  h.tiersError = null;
  h.recursosError = false;
  // Reloj fijo: a las 09:00 del estudio (Mazatlán, UTC-7) siempre quedan horas
  // ese día. Con el reloj real, corrido de noche no había ninguna hora que tocar.
  vi.setSystemTime(new Date('2026-09-22T16:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Reservar · pago por hora', () => {
  it('sin plan: tocar una hora ofrece comprar el paquete que alcanza y muestra su precio', async () => {
    montar();
    await tocarPrimeraHora();
    const dialogo = within(await screen.findByRole('dialog', { name: /pagar esta hora/i }));
    expect(dialogo.getByText(/Sesión suelta · \$250/)).toBeInTheDocument();
    expect(dialogo.getByText(/Sin membresía/)).toBeInTheDocument();
    expect(dialogo.getByRole('button', { name: /pagar y reservar/i })).toBeInTheDocument();
  });

  it('"Pagar y reservar" abre el pago del paquete elegido', async () => {
    montar();
    await tocarPrimeraHora();
    fireEvent.click(await screen.findByRole('button', { name: /pagar y reservar/i }));
    await waitFor(() => expect(h.pagoAbierto).toHaveBeenCalledWith('sesion-suelta', 250));
  });

  it('con un plan que SÍ tiene saldo no se ofrece nada: se abre la confirmación normal', async () => {
    h.usuario.membresia_tier = 'esencial';
    montar();
    await tocarPrimeraHora();
    expect(await screen.findByText('CONFIRMAR RESERVA')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /pagar esta hora/i })).not.toBeInTheDocument();
  });
});

// ── PKG-02A (C02 · F06) · plan/saldo no leídos → no se decide con datos falsos ─
describe('Reservar · resumen del miembro en error (PKG-02A)', () => {
  it('sin plan en `usuarios` pero resumen en ERROR: no ofrece comprar la hora (dinero) ni abre la confirmación; avisa y pide reintentar', async () => {
    h.resumen.error = true;
    montar();
    expect(await screen.findByText(/No pudimos cargar tu plan y tu saldo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.resumen.refetch).toHaveBeenCalledTimes(1);
    await tocarPrimeraHora();
    expect(screen.queryByRole('dialog', { name: /pagar esta hora/i })).not.toBeInTheDocument();
    expect(screen.queryByText('CONFIRMAR RESERVA')).not.toBeInTheDocument();
    expect(h.pagoAbierto).not.toHaveBeenCalled();
    expect(await screen.findByText(/Reintenta para poder reservar/)).toBeInTheDocument();
  });

  it('con plan en `usuarios` pero resumen en ERROR: tampoco abre la confirmación (no se inventa saldo)', async () => {
    h.usuario.membresia_tier = 'esencial';
    h.resumen.error = true;
    montar();
    await tocarPrimeraHora();
    expect(screen.queryByText('CONFIRMAR RESERVA')).not.toBeInTheDocument();
    expect(h.crearReserva).not.toHaveBeenCalled();
  });
});

// ── PKG-02A (C02 · F11/F18) ───────────────────────────────────────────────────
describe('Reservar · estudios y planes en error (PKG-02A)', () => {
  it('F11 · estudios en ERROR → "No pudimos cargar los estudios." + Reintentar; nunca "Sin estudios disponibles"', async () => {
    h.recursosError = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    expect(await screen.findByText('No pudimos cargar los estudios.')).toBeInTheDocument();
    expect(screen.queryByText('Sin estudios disponibles')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.recargarRecursos).toHaveBeenCalledTimes(1);
  });

  it('F18 · sin plan y planes en ERROR → no se ofrece "pagar esta hora" con lista vacía falsa; avisa y no concluye', async () => {
    h.tiersError = { message: 'permission denied' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    expect(await screen.findByText(/No pudimos cargar los planes disponibles para pagar por hora/)).toBeInTheDocument();
    await tocarPrimeraHora();
    expect(screen.queryByRole('dialog', { name: /pagar esta hora/i })).not.toBeInTheDocument();
    expect(h.pagoAbierto).not.toHaveBeenCalled();
    expect(await screen.findByText(/No pudimos cargar los planes disponibles\. Reintenta/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
  });
});
