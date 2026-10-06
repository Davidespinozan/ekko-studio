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

  it('PKG-03B: una discrepancia de Stripe se REVISA (sin botón de reparar); revisada sigue listada y sin acción', async () => {
    const dis = { ...base, dominio: 'stripe', tipo: 'discrepancia_pausa_distinta', fuente: 'discrepancias_stripe', fuente_id: 'd-1',
      severidad: 'alta', accion: 'revisar_discrepancia', detalle: 'sub_1 · EKKO: cobro en pausa (sancion) · Stripe: active · vista 2x' };
    const revisada = { ...dis, fuente_id: 'd-2', severidad: 'baja', accion: 'discrepancia_revisada' };
    const corrida = { ...base, dominio: 'stripe', tipo: 'reconciliacion_parcial', fuente: 'reconciliacion_stripe_corridas', fuente_id: 'c-1',
      severidad: 'media', accion: 'reconciliacion_incompleta', detalle: 'limite_paginas' };
    h.filas = [dis, revisada, corrida];
    montar();
    // Abierta y revisada: ambas siguen listadas (leída ≠ resuelta).
    expect(await screen.findAllByText('La pausa del cobro no coincide')).toHaveLength(2);
    expect(screen.getByText('La última reconciliación con Stripe quedó incompleta')).toBeInTheDocument();
    expect(screen.getAllByText('Marcar como revisada')).toHaveLength(1);
    expect(screen.queryByText(/reparar|corregir en stripe|reanudar/i)).toBeNull();
    fireEvent.click(screen.getByText('Marcar como revisada'));
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Revisado: el miembro sigue sancionado' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('revisar_discrepancia_stripe', { p_discrepancia_id: 'd-1', p_nota: 'Revisado: el miembro sigue sancionado' }));
    expect(await screen.findByRole('status')).toHaveTextContent('sigue abierta');
  });

  it('PKG-06G: proceso atrasado (sin botón de "correr"), push no entregado (se revisa con nota); el push dice que el hecho SÍ ocurrió', async () => {
    const proc = { ...base, dominio: 'procesos', tipo: 'proceso_atrasado', fuente: 'procesos_programados', fuente_id: 'cron-no-shows',
      severidad: 'alta', accion: 'revisar_proceso', detalle: 'cron-no-shows · 0 * * * * · último estado: exito' };
    const push = { ...base, dominio: 'entrega', tipo: 'push_no_entregado', fuente: 'notificaciones_push', fuente_id: 'push:t1',
      severidad: 'baja', accion: 'revisar_fallos_push', detalle: '3 sin entregar · recordatorio_reserva' };
    h.filas = [proc, push];
    montar();
    expect(await screen.findByTestId('dominio-procesos')).toBeInTheDocument();
    expect(screen.getByText('Un proceso automático no ha corrido a tiempo')).toBeInTheDocument();
    expect(screen.getByText(/EKKO no lo corre ni lo repara solo/)).toBeInTheDocument();
    expect(screen.queryByText(/correr ahora|ejecutar/i)).toBeNull();
    expect(screen.getByText(/Lo que se avisó SÍ ocurrió/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Marcar como revisado'));
    fireEvent.change(screen.getByLabelText('Nota (obligatoria)'), { target: { value: 'Revisé las llaves VAPID en Netlify' } });
    fireEvent.click(screen.getByText('Guardar'));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('revisar_fallos_push', { p_nota: 'Revisé las llaves VAPID en Netlify' }));
  });

  it('PKG-06B: la suscripción anterior sin cancelar se nombra como posible doble cobro (alta); un cambio de plan se revisa, NO se reintenta', async () => {
    const anterior = { ...opAgotada, tipo: 'cancelar_suscripcion', fuente_id: 'op-a', severidad: 'alta', accion: 'vigilar_operacion', detalle: 'suscripcion_anterior · api_error:timeout' };
    const plan = { ...opAgotada, tipo: 'cambiar_plan', fuente_id: 'op-p', severidad: 'media', accion: 'revisar_cambio_plan', detalle: 'cambio_plan_miembro · resultado_desconocido' };
    h.filas = [anterior, plan];
    montar();
    expect(await screen.findByText('Suscripción anterior sin cancelar: posible doble cobro')).toBeInTheDocument();
    expect(screen.getByText('Cambio de plan del miembro sin confirmar')).toBeInTheDocument();
    expect(screen.getByText(/EKKO no lo cambia por su cuenta/)).toBeInTheDocument();
    expect(screen.queryByText('Reintentar')).toBeNull();
    expect(screen.getAllByText('Descartar')).toHaveLength(2);
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
