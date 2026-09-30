import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  obtenerOperacionPago,
  operacionPagoActual,
  descartarOperacionPago,
  marcarOperacionConfirmada,
  limpiarPagoPendiente,
  guardarPagoPendiente,
  leerPagoPendiente,
  interpretarResultadoPago,
  CLAVE_OPERACIONES_PAGO,
  CLAVE_PAGO_PENDIENTE
} from '../pagoEstado';

/**
 * PKG-01C (frontend) — identidad de la operación de pago: un operation_id por
 * intención (usuario + objetivo), reutilizado en reintentos, refresh y pestañas;
 * reemplazado solo con evidencia; nunca por antigüedad. Sin PII ni secretos.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sinLocks = { locks: null, esperar: async () => {} };

/** Web Locks simulado: exclusión real entre llamadas concurrentes (cola por nombre). */
function locksSimulados() {
  const colas = new Map<string, Promise<unknown>>();
  return {
    request: vi.fn(<T,>(nombre: string, cb: () => Promise<T> | T): Promise<T> => {
      const previa = colas.get(nombre) ?? Promise.resolve();
      const turno = previa.then(async () => {
        await new Promise((r) => setTimeout(r, 5)); // ventana en la que otra pestaña podría intercalar
        return cb();
      });
      colas.set(nombre, turno.catch(() => undefined));
      return turno;
    })
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('operation_id por intención', () => {
  it('1/2 · misma intención → mismo id en llamadas sucesivas (reintento HTTP)', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    const b = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    expect(a).toMatch(UUID);
    expect(b).toBe(a);
  });

  it('3 · refresh: el id vive en localStorage y se relee igual', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    // "Refresh": nada en memoria, solo lo persistido.
    expect(JSON.parse(window.localStorage.getItem(CLAVE_OPERACIONES_PAGO)!)).toMatchObject({ 'u-1|paquete:pack4': { id: a } });
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBe(a);
  });

  it('namespace por usuario y objetivo: otro usuario u otro objetivo → otra intención', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    expect(await obtenerOperacionPago('u-2', 'paquete:pack4', sinLocks)).not.toBe(a);
    expect(await obtenerOperacionPago('u-1', 'invitados:r1:2', sinLocks)).not.toBe(a);
  });

  it('4 · dos pestañas CONCURRENTES con Web Locks → el MISMO operation_id', async () => {
    const locks = locksSimulados();
    const [a, b] = await Promise.all([
      obtenerOperacionPago('u-1', 'mensual:esencial', { locks: locks as never }),
      obtenerOperacionPago('u-1', 'mensual:esencial', { locks: locks as never })
    ]);
    expect(a).toBe(b);
    expect(locks.request).toHaveBeenCalledWith('ekko-op:u-1|mensual:esencial', expect.any(Function));
  });

  it('5 · sin Web Locks: escribe, espera y RELEE — si otra pestaña escribió en medio, converge a lo persistido', async () => {
    const otro = '11111111-2222-4333-8444-555555555555';
    const id = await obtenerOperacionPago('u-1', 'paquete:pack4', {
      locks: null,
      // Otra pestaña escribe su candidato durante la espera (carrera sin locks).
      esperar: async () => {
        window.localStorage.setItem(CLAVE_OPERACIONES_PAGO, JSON.stringify({ 'u-1|paquete:pack4': { id: otro, ts: 1 } }));
      }
    });
    expect(id).toBe(otro);
    // Residual documentado: sin Web Locks no hay exclusión mutua perfecta entre pestañas.
  });

  it('6 · nueva intención legítima tras resolver → id nuevo', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    descartarOperacionPago('u-1', 'paquete:pack4', a);
    const b = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    expect(b).not.toBe(a);
  });

  it('descartar solo borra si sigue siendo ESE id (no pisa una operación más nueva de otra pestaña)', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    descartarOperacionPago('u-1', 'paquete:pack4', '00000000-0000-4000-8000-000000000000');
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBe(a);
  });

  it('10 · la ANTIGÜEDAD nunca autoriza otra operación: un registro de hace 90 días se reutiliza igual', async () => {
    const viejo = '22222222-3333-4444-8555-666666666666';
    window.localStorage.setItem(CLAVE_OPERACIONES_PAGO, JSON.stringify({ 'u-1|paquete:pack4': { id: viejo, ts: Date.now() - 90 * 86_400_000 } }));
    expect(await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks)).toBe(viejo);
  });

  it('confirmada: solo se limpia cuando 02B observa el derecho (limpiarPagoPendiente); las no confirmadas se conservan', async () => {
    const a = await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    const b = await obtenerOperacionPago('u-1', 'invitados:r1:2', sinLocks);
    marcarOperacionConfirmada('u-1', 'paquete:pack4', a);
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBe(a); // confirmada ≠ borrada
    guardarPagoPendiente({ flujo: 'perfil', paymentIntentId: 'pi_1', estado: 'confirmado' });
    limpiarPagoPendiente();
    expect(operacionPagoActual('u-1', 'paquete:pack4')).toBeNull();
    expect(operacionPagoActual('u-1', 'invitados:r1:2')).toBe(b);
  });

  it('32 · 02B intacto: limpiarPagoPendiente sigue borrando el pendiente de sessionStorage', () => {
    guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: 'pi_1', estado: 'confirmado' });
    expect(leerPagoPendiente('pagar')).not.toBeNull();
    limpiarPagoPendiente();
    expect(window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)).toBeNull();
  });

  it('28 · lo persistido no contiene PII, secretos ni montos', async () => {
    await obtenerOperacionPago('u-1', 'paquete:pack4', sinLocks);
    const raw = window.localStorage.getItem(CLAVE_OPERACIONES_PAGO)!;
    expect(raw).not.toMatch(/secret|@|monto|amount|nombre|email/i);
    const registro = Object.values(JSON.parse(raw))[0] as Record<string, unknown>;
    expect(Object.keys(registro).sort()).toEqual(['id', 'ts']);
  });
});

describe('interpretarResultadoPago · PI reutilizado ya cobrado en otra pestaña', () => {
  it('error de estado con PI succeeded → confirmado (no "falló", no invitar a pagar de nuevo)', () => {
    expect(
      interpretarResultadoPago({ error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', payment_intent: { id: 'pi_9', status: 'succeeded' } } })
    ).toEqual({ tipo: 'confirmado', paymentIntentId: 'pi_9' });
    expect(
      interpretarResultadoPago({ error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', payment_intent: { id: 'pi_9', status: 'processing' } } })
    ).toEqual({ tipo: 'en_proceso', paymentIntentId: 'pi_9' });
  });
  it('un error sin PI cobrado sigue siendo fallido', () => {
    expect(interpretarResultadoPago({ error: { type: 'card_error', message: 'Rechazada', payment_intent: { id: 'pi_9', status: 'requires_payment_method' } } }).tipo).toBe('fallido');
  });
});
