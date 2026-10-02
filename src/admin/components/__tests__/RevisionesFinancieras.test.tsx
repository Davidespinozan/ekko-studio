import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-01G · UI mínima de revisiones financieras (Cobros) y banner del miembro.
 * Lo que puede hacer el admin: ver evidencia y documentar una resolución.
 * Lo que NO puede hacer desde aquí: tocar créditos, membresías, cuentas,
 * planes ni reservas (no existe ningún botón ni RPC para eso).
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, unknown[]>,
  rpc: vi.fn(),
  consultas: [] as string[]
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      h.consultas.push(tabla);
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: h.porTabla[tabla] ?? [], error: null }).then(cb);
      return c;
    },
    rpc: (...a: unknown[]) => h.rpc(...a)
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import { RevisionesFinancieras } from '../cobros/RevisionesFinancieras';
import { AvisoRevisionFinanciera } from '../miembro/AvisoRevisionFinanciera';

const reversal = { id: 'rv1', tipo: 'reembolso', stripe_object_id: 're_1', stripe_charge_id: 'ch_1', monto_centavos: 10000, moneda: 'mxn', estado_proveedor: 'succeeded', motivo_proveedor: 'requested_by_customer', pago_origen_id: 'pe1', membresia_origen_id: 'mem1', usuario_id: 'u1', stripe_created_at: '2026-10-02T10:00:00Z' };
const abierta = { id: 'rev1', tipo: 'reembolso', referencia: null, estado: 'abierta', resolucion: null, nota: null, detalle: {}, actor_rol: null, abierta_at: '2026-10-02T10:01:00Z', resuelta_at: null, reabierta_at: null, reversal_id: 'rv1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas.length = 0;
  h.porTabla = {
    revisiones_financieras: [abierta, { ...abierta, id: 'rev2', estado: 'resuelta', resolucion: 'disputa_ganada', actor_rol: 'sistema', resuelta_at: '2026-10-02T11:00:00Z', tipo: 'disputa_abierta', reversal_id: null, referencia: 'dp_x' }],
    reversales_pago: [reversal],
    usuarios: [{ id: 'u1', nombre: 'Ana López' }]
  };
  h.rpc.mockResolvedValue({ data: { success: true }, error: null });
});

describe('RevisionesFinancieras', () => {
  it('muestra la evidencia exacta del reembolso (monto del objeto re_, estado, miembro, origen identificado) y el conteo de abiertas', async () => {
    render(<MemoryRouter><RevisionesFinancieras /></MemoryRouter>);
    await screen.findByTestId('revision-abierta');
    expect(screen.getByText('1 abierta')).toBeInTheDocument();
    expect(screen.getByText('Reembolso')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText(/reembolsado · motivo Stripe: requested_by_customer/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ana López' })).toHaveAttribute('href', '/admin/miembros/u1');
    expect(screen.getByText(/pago de origen identificado/)).toBeInTheDocument();
    expect(screen.getByText('re_1')).toBeInTheDocument();
    // Explicita que el sistema no muta derechos.
    expect(screen.getByTestId('revisiones-financieras')).toHaveTextContent(/no quita créditos ni cancela membresías/i);
  });

  it('no ofrece ninguna acción sobre derechos: solo "Marcar como revisada" y, dentro, resolución + nota', async () => {
    render(<MemoryRouter><RevisionesFinancieras /></MemoryRouter>);
    await screen.findByTestId('revision-abierta');
    const botones = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(botones.some((t) => /revisada/i.test(t))).toBe(true);
    for (const prohibido of [/quitar/i, /descontar/i, /cancelar membres/i, /revocar/i, /revertir/i, /cancelar reserva/i]) {
      expect(botones.some((t) => prohibido.test(t))).toBe(false);
    }
  });

  it('resolver: exige nota ≥ 10, llama resolver_revision_financiera con la resolución elegida y refresca; ninguna otra RPC', async () => {
    render(<MemoryRouter><RevisionesFinancieras /></MemoryRouter>);
    await screen.findByTestId('revision-abierta');
    fireEvent.click(screen.getByRole('button', { name: /marcar como revisada/i }));
    const guardar = screen.getByRole('button', { name: /guardar resolución/i });
    expect(guardar).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Resolución'), { target: { value: 'ajuste_manual_registrado' } });
    fireEvent.change(screen.getByLabelText(/Nota/), { target: { value: 'Ajusté 1 crédito desde la ficha del miembro' } });
    expect(guardar).not.toBeDisabled();
    h.porTabla.revisiones_financieras = [{ ...abierta, estado: 'resuelta', resolucion: 'ajuste_manual_registrado', resuelta_at: '2026-10-02T12:00:00Z', actor_rol: 'admin', nota: 'Ajusté 1 crédito desde la ficha del miembro' }];
    fireEvent.click(guardar);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('resolver_revision_financiera', { p_revision_id: 'rev1', p_resolucion: 'ajuste_manual_registrado', p_nota: 'Ajusté 1 crédito desde la ficha del miembro' }));
    expect(h.rpc).toHaveBeenCalledTimes(1);
    await screen.findByText('sin pendientes');
  });

  it('error de autorización de la RPC se muestra sin romper', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_NO_AUTORIZADO: Solo un admin' } });
    render(<MemoryRouter><RevisionesFinancieras /></MemoryRouter>);
    await screen.findByTestId('revision-abierta');
    fireEvent.click(screen.getByRole('button', { name: /marcar como revisada/i }));
    fireEvent.change(screen.getByLabelText(/Nota/), { target: { value: 'Revisado con el miembro hoy' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar resolución/i }));
    await screen.findByText('Solo un admin puede resolver revisiones financieras.');
  });

  it('las resueltas se listan aparte (con resolución y actor) al desplegarlas', async () => {
    render(<MemoryRouter><RevisionesFinancieras /></MemoryRouter>);
    await screen.findByTestId('revision-abierta');
    fireEvent.click(screen.getByRole('button', { name: /ver resueltas/i }));
    expect(screen.getByTestId('revision-resuelta')).toHaveTextContent('Disputa abierta');
    expect(screen.getByTestId('revision-resuelta')).toHaveTextContent('Disputa ganada (sistema)');
  });
});

describe('AvisoRevisionFinanciera (ficha del miembro)', () => {
  it('con revisión abierta atribuida al miembro → banner informativo con enlace a Cobros y sin acciones', async () => {
    render(<MemoryRouter><AvisoRevisionFinanciera usuarioId="u1" /></MemoryRouter>);
    const banner = await screen.findByTestId('aviso-revision-financiera');
    expect(banner).toHaveTextContent('Hay una revisión financiera abierta');
    expect(banner).toHaveTextContent('no cambió sus créditos ni su membresía');
    expect(screen.getByRole('link', { name: /revisar en cobros/i })).toHaveAttribute('href', '/admin/cobros');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('otro miembro / sin revisiones → no renderiza nada', async () => {
    const { container } = render(<MemoryRouter><AvisoRevisionFinanciera usuarioId="u2" /></MemoryRouter>);
    await waitFor(() => expect(h.consultas).toContain('revisiones_financieras'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
