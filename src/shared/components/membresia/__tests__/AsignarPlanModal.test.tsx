import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

const PLANES = [
  { slug: 'esencial', nombre: 'Esencial', tipo: 'tiempo', precio_centavos: 85000, clases_incluidas: null, duracion_dias: null },
  { slug: 'pro-pack', nombre: 'Pro-pack', tipo: 'hibrido', precio_centavos: 199000, clases_incluidas: 12, duracion_dias: 120 }
];

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => Promise.resolve({ data: PLANES, error: null });
      return c;
    })
  }
}));

const mockActivar = vi.fn();
vi.mock('@shared/lib/checkout', async (orig) => ({
  ...(await orig<typeof import('@shared/lib/checkout')>()),
  activarMembresiaMostrador: (...a: unknown[]) => mockActivar(...a)
}));

import { AsignarPlanModal } from '../AsignarPlanModal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const onDone = vi.fn();
const onClose = vi.fn();

function abrir(modo: 'asignar' | 'renovar' | 'cambiar' = 'asignar', planActualSlug: string | null = null) {
  return render(
    <ToastProvider>
      <AsignarPlanModal usuarioId="m1" nombre="Ana" modo={modo} planActualSlug={planActualSlug} onClose={onClose} onDone={onDone} />
    </ToastProvider>
  );
}

const error409 = Object.assign(new Error('El miembro perdería 8 crédito(s) al cambiar a este plan. Confirma para continuar.'), { status: 409 });
const error409Stripe = Object.assign(new Error('El miembro tiene una suscripción de Stripe vigente. Cancélala primero desde su membresía; la venta de mostrador no la sustituye.'), { status: 409 });

beforeEach(() => {
  vi.clearAllMocks();
  mockActivar.mockResolvedValue({ success: true });
});

describe('AsignarPlanModal', () => {
  it('lista los planes con lo que incluyen, y no deja confirmar sin elegir uno', async () => {
    abrir();
    expect(await screen.findByText(/12 créditos · 120 días/)).toBeInTheDocument();
    expect(screen.getByText(/mensual, acceso ilimitado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activar plan/i })).toBeDisabled();
  });

  it('renovar: preselecciona el plan actual', async () => {
    abrir('renovar', 'pro-pack');
    await screen.findByText('Pro-pack');
    expect(screen.getByRole('radio', { name: /pro-pack/i })).toBeChecked();
  });

  it('activa en UN paso, mandando método + nota y SIN autorizar pérdida de créditos; nunca un importe', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Transferencia' }));
    fireEvent.change(screen.getByPlaceholderText(/folio/i), { target: { value: 'Folio 8841' } });
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockActivar).toHaveBeenCalledWith('m1', 'esencial', {
      operationId: expect.stringMatching(UUID), metodo: 'transferencia', confirmarPerdida: false, nota: 'Folio 8841'
    });
    expect(Object.keys(mockActivar.mock.calls[0][2] as object)).not.toContain('monto');
    expect(onClose).toHaveBeenCalled();
  });

  it('sin método no activa (la nota es opcional; el método es la evidencia)', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    expect(screen.getByRole('button', { name: /activar plan/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    expect(mockActivar).not.toHaveBeenCalled();
  });

  it('el SERVIDOR avisa que se perderían créditos (409): pide confirmar y reintenta autorizándolo con el MISMO operation_id', async () => {
    mockActivar.mockRejectedValueOnce(error409);
    abrir('cambiar', 'pro-pack');
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/8 créditos.*se perderán/i);
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /sí, cambiar y perder créditos/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const primera = mockActivar.mock.calls[0][2] as { operationId: string };
    expect(mockActivar).toHaveBeenLastCalledWith('m1', 'esencial', { operationId: primera.operationId, metodo: 'efectivo', confirmarPerdida: true, nota: undefined });
  });

  it('si tras el aviso elige OTRO plan, la confirmación anterior deja de valer', async () => {
    mockActivar.mockRejectedValueOnce(error409);
    abrir('cambiar', 'pro-pack');
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('radio', { name: /pro-pack/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(mockActivar).toHaveBeenCalledTimes(2));
    expect(mockActivar).toHaveBeenLastCalledWith('m1', 'pro-pack', expect.objectContaining({ metodo: 'efectivo', confirmarPerdida: false }));
  });
});

// ── PKG-02B (C28 · visual) ────────────────────────────────────────────────────
describe('AsignarPlanModal · plan actual en "Cambiar plan" (PKG-02B · C28)', () => {
  it('30 · en modo cambiar, el plan actual queda deshabilitado y explica que para repetirlo se usa Renovar', async () => {
    abrir('cambiar', 'pro-pack');
    const actual = await screen.findByRole('radio', { name: /pro-pack/i });
    expect(actual).toBeDisabled();
    expect(screen.getByText(/plan actual \(para repetirlo usa Renovar\)/)).toBeInTheDocument();
    // El otro plan sigue eligible.
    expect(screen.getByRole('radio', { name: /esencial/i })).not.toBeDisabled();
  });

  it('en modo renovar el plan actual NO se deshabilita (es justo lo que se repite)', async () => {
    abrir('renovar', 'pro-pack');
    const actual = await screen.findByRole('radio', { name: /pro-pack/i });
    expect(actual).not.toBeDisabled();
    expect(actual).toBeChecked();
    expect(screen.queryByText(/para repetirlo usa Renovar/)).not.toBeInTheDocument();
  });
});

// ── PKG-01D · venta de mostrador ─────────────────────────────────────────────
describe('AsignarPlanModal · venta de mostrador (PKG-01D)', () => {
  it('la misma apertura conserva el operation_id ante un error de red; la reapertura genera otro', async () => {
    mockActivar.mockRejectedValueOnce(new Error('HTTP 502'));
    const r = abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal (tarjeta)' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(mockActivar).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(mockActivar).toHaveBeenCalledTimes(2));
    const [a, b] = mockActivar.mock.calls.map((c) => (c[2] as { operationId: string }).operationId);
    expect(a).toBe(b);
    r.unmount();
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal (tarjeta)' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(mockActivar).toHaveBeenCalledTimes(3));
    expect((mockActivar.mock.calls[2][2] as { operationId: string }).operationId).not.toBe(a);
  });

  it('cortesía: $0 cobrado con el precio de lista visible; efectivo: cobrado = precio de lista', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Cortesía' }));
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('$0 cobrado');
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('Precio de lista $850');
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('$850 cobrado');
  });

  it('409 por suscripción de Stripe viva NO se confunde con pérdida de créditos: mensaje propio y sin reintento', async () => {
    mockActivar.mockRejectedValueOnce(error409Stripe);
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(mockActivar).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/se perderán/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activar plan/i })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('el éxito se afirma solo con la confirmación del servidor; un replay idempotente lo dice', async () => {
    mockActivar.mockResolvedValueOnce({ success: true, idempotente: true, venta: { monto_cobrado_centavos: 85000 } });
    abrir();
    fireEvent.click(await screen.findByRole('radio', { name: /esencial/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    fireEvent.click(screen.getByRole('button', { name: /activar plan/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
