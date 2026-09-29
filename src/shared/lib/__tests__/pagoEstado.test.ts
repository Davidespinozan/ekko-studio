import { describe, it, expect, beforeEach } from 'vitest';
import {
  interpretarResultadoPago,
  mensajeParaResultado,
  mensajeErrorStripe,
  leerRetornoPago,
  urlRetornoPago,
  guardarPagoPendiente,
  leerPagoPendiente,
  limpiarPagoPendiente,
  pagoPendienteEsAntiguo,
  mensajePagoPendiente,
  CLAVE_PAGO_PENDIENTE,
  PAGO_PENDIENTE_ANTIGUO_MS,
  MENSAJE_PAGO
} from '../pagoEstado';

/**
 * PKG-02B (C04) — helpers puros: solo `succeeded` es pago confirmado; el retorno
 * de un redirect se lee tal cual; el pendiente persistido no lleva secretos ni
 * PII y su antigüedad solo cambia el copy (nunca desbloquea otro cobro).
 */

describe('interpretarResultadoPago', () => {
  it('error de Stripe → fallido con mensaje seguro (card/validation muestran el de Stripe; el resto, genérico)', () => {
    expect(interpretarResultadoPago({ error: { type: 'card_error', message: 'Tu tarjeta fue rechazada.' } })).toEqual({ tipo: 'fallido', mensaje: 'Tu tarjeta fue rechazada.' });
    expect(interpretarResultadoPago({ error: { type: 'api_error', message: 'Internal: pi_123 db timeout' } })).toEqual({ tipo: 'fallido', mensaje: MENSAJE_PAGO.fallidoGenerico });
    expect(mensajeErrorStripe({ type: 'api_connection_error', message: 'ECONNRESET' })).toBe(MENSAJE_PAGO.fallidoGenerico);
  });

  it('succeeded → confirmado con el id del PaymentIntent', () => {
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_1', status: 'succeeded' } })).toEqual({ tipo: 'confirmado', paymentIntentId: 'pi_1' });
  });

  it('processing → en_proceso (ni éxito ni fallo)', () => {
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_2', status: 'processing' } })).toEqual({ tipo: 'en_proceso', paymentIntentId: 'pi_2' });
    expect(mensajeParaResultado({ tipo: 'en_proceso', paymentIntentId: 'pi_2' })).toMatch(/en proceso.*No lo repitas/);
  });

  it('requires_action / requires_confirmation → requiere_accion; requires_payment_method / canceled → requiere_metodo', () => {
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_3', status: 'requires_action' } }).tipo).toBe('requiere_accion');
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_3', status: 'requires_confirmation' } }).tipo).toBe('requiere_accion');
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_4', status: 'requires_payment_method' } }).tipo).toBe('requiere_metodo');
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_4', status: 'canceled' } }).tipo).toBe('requiere_metodo');
  });

  it('sin PI y sin error, PI sin status, status raro o succeeded sin id → desconocido (nunca confirmado)', () => {
    expect(interpretarResultadoPago({}).tipo).toBe('desconocido');
    expect(interpretarResultadoPago(undefined).tipo).toBe('desconocido');
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_5' } }).tipo).toBe('desconocido');
    expect(interpretarResultadoPago({ paymentIntent: { id: 'pi_5', status: 'requires_capture' } }).tipo).toBe('desconocido');
    expect(interpretarResultadoPago({ paymentIntent: { status: 'succeeded' } }).tipo).toBe('desconocido');
  });

  it('ningún mensaje de resultado contiene ids ni texto técnico', () => {
    for (const r of [
      interpretarResultadoPago({ paymentIntent: { id: 'pi_secreto', status: 'processing' } }),
      interpretarResultadoPago({ paymentIntent: { id: 'pi_secreto', status: 'requires_action' } }),
      interpretarResultadoPago({ error: { type: 'invalid_request_error', message: 'No such payment_intent: pi_secreto' } })
    ]) {
      expect(mensajeParaResultado(r)).not.toMatch(/pi_|payment_intent|No such/);
    }
  });
});

describe('retorno de redirect', () => {
  it('urlRetornoPago conserva el flujo y vuelve a la pantalla correcta', () => {
    expect(urlRetornoPago('https://ekko.test', 'perfil')).toBe('https://ekko.test/app/perfil?pago=perfil');
    expect(urlRetornoPago('https://ekko.test', 'pagar')).toBe('https://ekko.test/app?pago=pagar');
    expect(urlRetornoPago('https://ekko.test', 'hora')).toBe('https://ekko.test/app/reservar?pago=hora');
    expect(urlRetornoPago('https://ekko.test', 'invitados')).toBe('https://ekko.test/app/reservas?pago=invitados');
  });

  it('leerRetornoPago: succeeded / processing / requires_payment_method(failed) / desconocido; ignora el client_secret', () => {
    expect(leerRetornoPago('?pago=perfil&payment_intent=pi_9&payment_intent_client_secret=pi_9_secret_abc&redirect_status=succeeded'))
      .toEqual({ flujo: 'perfil', estado: 'succeeded', paymentIntentId: 'pi_9' });
    expect(leerRetornoPago('?pago=hora&redirect_status=processing').estado).toBe('processing');
    expect(leerRetornoPago('?pago=pagar&redirect_status=requires_payment_method').estado).toBe('failed');
    expect(leerRetornoPago('?pago=pagar&redirect_status=failed').estado).toBe('failed');
    expect(leerRetornoPago('?pago=pagar&redirect_status=algo').estado).toBe('desconocido');
    expect(leerRetornoPago('?recurso=black')).toEqual({ flujo: null, estado: null, paymentIntentId: null });
    expect(leerRetornoPago('?pago=xxx&redirect_status=succeeded').flujo).toBeNull();
    expect(leerRetornoPago('?pago=perfil&payment_intent=<script>&redirect_status=succeeded').paymentIntentId).toBeNull();
  });
});

describe('pago pendiente persistido (sessionStorage)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('guarda solo flujo, id técnico, estado, ts y contexto técnico; filtra claves con PII/secretos', () => {
    const p = guardarPagoPendiente({
      flujo: 'hora', paymentIntentId: 'pi_1', estado: 'confirmado',
      contexto: { slotInicio: '2026-10-01T10:00:00Z', costo: 1, clientSecret: 'pi_1_secret_x', email: 'ana@e.mx', nombre: 'Ana' } as Record<string, string | number>
    });
    const raw = window.sessionStorage.getItem(CLAVE_PAGO_PENDIENTE)!;
    expect(raw).not.toMatch(/secret|ana@e\.mx|Ana/);
    expect(JSON.parse(raw)).toEqual({ flujo: 'hora', paymentIntentId: 'pi_1', estado: 'confirmado', ts: p.ts, contexto: { slotInicio: '2026-10-01T10:00:00Z', costo: 1 } });
    expect(leerPagoPendiente('hora')?.paymentIntentId).toBe('pi_1');
    expect(leerPagoPendiente('perfil')).toBeNull(); // otro flujo no lo ve
  });

  it('leer tolera basura y ausencia; limpiar borra', () => {
    expect(leerPagoPendiente()).toBeNull();
    window.sessionStorage.setItem(CLAVE_PAGO_PENDIENTE, '{"flujo":"perfil","estado":"pagado"}');
    expect(leerPagoPendiente()).toBeNull();
    window.sessionStorage.setItem(CLAVE_PAGO_PENDIENTE, 'no-json');
    expect(leerPagoPendiente()).toBeNull();
    guardarPagoPendiente({ flujo: 'perfil', paymentIntentId: null, estado: 'en_proceso' });
    expect(leerPagoPendiente()).not.toBeNull();
    limpiarPagoPendiente();
    expect(leerPagoPendiente()).toBeNull();
  });

  it('la antigüedad solo cambia el copy: antiguo NO significa "seguro volver a cobrar"', () => {
    const ahora = 1_800_000_000_000;
    const reciente = { flujo: 'perfil' as const, paymentIntentId: 'pi_1', estado: 'confirmado' as const, ts: ahora - 60_000 };
    const antiguo = { ...reciente, ts: ahora - PAGO_PENDIENTE_ANTIGUO_MS - 1 };
    expect(pagoPendienteEsAntiguo(reciente, ahora)).toBe(false);
    expect(pagoPendienteEsAntiguo(antiguo, ahora)).toBe(true);
    expect(mensajePagoPendiente(reciente, ahora)).toBe(MENSAJE_PAGO.activacionTarda);
    expect(mensajePagoPendiente(antiguo, ahora)).toBe(MENSAJE_PAGO.activacionSinConfirmar);
    expect(mensajePagoPendiente(antiguo, ahora)).toMatch(/No vuelvas a pagar/);
    expect(mensajePagoPendiente({ ...reciente, estado: 'en_proceso' }, ahora)).toBe(MENSAJE_PAGO.pagoEnProcesoPersistido);
    expect(mensajePagoPendiente({ ...reciente, estado: 'desconocido' }, ahora)).toBe(MENSAJE_PAGO.desconocido);
  });
});
