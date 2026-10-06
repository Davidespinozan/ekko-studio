import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-03A · Página Operación: muestra lo que deriva `v_pendientes_operativos`,
 * cada acción va a la RPC del servidor de su dominio con nota, y no afirma éxito
 * antes de que el servidor confirme. Un fallo al cargar no se muestra como vacío.
 */

const h = vi.hoisted(() => ({
  filas: [] as unknown[],
  errorCarga: null as { message: string } | null,
  rpc: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => Promise.resolve({ data: h.errorCarga ? null : h.filas, error: h.errorCarga }) }),
    rpc: (...a: unknown[]) => h.rpc(...a)
  }
}));

import Operacion from '../Operacion';

const montar = () => render(<MemoryRouter><Operacion /></MemoryRouter>);
const base = { usuario_id: null, desde: '2026-10-02T16:24:58Z', detalle: null, ruta: '/admin/operacion' };
const evento = { ...base, dominio: 'stripe', tipo: 'evento_revision', fuente: 'stripe_webhook_events', fuente_id: 'evt_1', severidad: 'alta', accion: 'resolver_evento', detalle: 'customer.subscription.updated · membresia_no_encontrada' };
const opAgotada = { ...base, dominio: 'cobro', tipo: 'suspender_cobro', fuente: 'stripe_operaciones_suscripcion', fuente_id: 'op-1', severidad: 'alta', accion: 'decidir_operacion', usuario_id: 'u-1' };
const opVigilada = { ...opAgotada, fuente_id: 'op-2', severidad: 'media', accion: 'vigilar_operacion' };
const correo = { ...base, dominio: 'entrega', tipo: 'correo_aviso_fallido', fuente: 'notificaciones', fuente_id: 'n-1', severidad: 'baja', accion: 'atender_fallo_entrega' };
const revision = { ...base, dominio: 'finanzas', tipo: 'credito_no_restaurado', fuente: 'revisiones_financieras', fuente_id: 'r-1', severidad: 'alta', accion: 'resolver_revision', ruta: '/admin/cobros' };

beforeEach(() => {
  vi.clearAllMocks();
  h.errorCarga = null;
  h.filas = [evento, opAgotada, opVigilada, correo, revision];
  h.rpc.mockResolvedValue({ data: { success: true }, error: null });
});

describe('Operación (PKG-03A)', () => {
  it('agrupa por dominio con la acción que corresponde; las revisiones se resuelven en Cobros', async () => {
    montar();
    expect(await screen.findByTestId('dominio-stripe')).toBeInTheDocument();
    expect(screen.getByTestId('dominio-cobro')).toBeInTheDocument();
    expect(screen.getByTestId('dominio-entrega')).toBeInTheDocument();
    expect(screen.getByText('Ir a Cobros').getAttribute('href')).toBe('/admin/cobros');
    // Reintentar solo cuando se agotó; descartar en ambas.
    expect(screen.getAllByText('Reintentar')).toHaveLength(1);
    expect(screen.getAllByText('Descartar')).toHaveLength(2);
    // "Leído" no existe como acción: se resuelve con nota.
    expect(screen.queryByText(/marcar como leíd/i)).toBeNull();
  });

  it('resolver un evento: RPC del servidor con resolución y nota; el éxito sale solo tras confirmar', async () => {
    let confirmar: (v: unknown) => void = () => {};
    h.rpc.mockReturnValueOnce(new Promise((r) => { confirmar = r; }));
    montar();
    fireEvent.click(await screen.findByText('Resolver'));
    const guardar = screen.getByText('Guardar') as HTMLButtonElement;
    expect(guardar.disabled).toBe(true); // nota obligatoria
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Lo reenvié desde el panel de Stripe hoy' } });
    fireEvent.click(screen.getByText('Guardar'));
    expect(h.rpc).toHaveBeenCalledWith('resolver_evento_stripe', { p_evento_id: 'evt_1', p_resolucion: 'reenviado_desde_stripe', p_nota: 'Lo reenvié desde el panel de Stripe hoy' });
    expect(screen.queryByRole('status')).toBeNull();
    confirmar({ data: { success: true }, error: null });
    expect(await screen.findByRole('status')).toHaveTextContent('quedó registrado');
  });

  it('un rechazo del servidor se muestra traducido y no se declara éxito', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_OPERACION_CERRADA: ya aplicada' } });
    montar();
    fireEvent.click((await screen.findAllByText('Descartar'))[0]);
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Ya se canceló a mano en Stripe' } });
    fireEvent.click(screen.getByText('Guardar'));
    expect(await screen.findByText('Esta operación ya está cerrada (aplicada o descartada).')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(h.rpc).toHaveBeenCalledWith('staff_descartar_operacion_cobro', { p_operacion_id: 'op-1', p_nota: 'Ya se canceló a mano en Stripe' });
  });

  it('reintentar y atender un correo van a sus RPC', async () => {
    montar();
    fireEvent.click(await screen.findByText('Reintentar'));
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Se corrigió la tarjeta en Stripe' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('staff_reintentar_operacion_cobro', { p_operacion_id: 'op-1', p_nota: 'Se corrigió la tarjeta en Stripe' }));
    fireEvent.click(await screen.findByText('Marcar como atendido'));
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Se le avisó por WhatsApp' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('resolver_fallo_entrega', { p_fuente: 'notificaciones', p_id: 'n-1', p_nota: 'Se le avisó por WhatsApp' }));
  });

  it('vacío legítimo → "Nada pendiente"; fallo al cargar → error, nunca "Nada pendiente"', async () => {
    h.filas = [];
    const { unmount } = montar();
    expect(await screen.findByTestId('operacion-vacia')).toBeInTheDocument();
    unmount();
    h.errorCarga = { message: 'permission denied' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    expect(await screen.findByTestId('error-carga')).toBeInTheDocument();
    expect(screen.queryByTestId('operacion-vacia')).toBeNull();
  });
});
