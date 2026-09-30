import { describe, it, expect, vi } from 'vitest';

vi.mock('@shared/lib/backend', () => ({ backendPost: vi.fn(async () => ({ success: true })) }));

import { backendPost } from '@shared/lib/backend';
import {
  activarMembresiaMostrador,
  esPerdidaDeCreditos,
  conflictoVentaMostrador,
  montoCobradoMostrador,
  nuevaOperacionMostrador,
  METODOS_MOSTRADOR
} from '../checkout';

/** PKG-01D — helpers de la venta de mostrador: sin importes del cliente; 409 bien clasificados. */

const e409 = (message: string) => Object.assign(new Error(message), { status: 409 });

describe('activarMembresiaMostrador', () => {
  it('manda operation_id y metodo; nunca un importe, precio, moneda ni actor', async () => {
    await activarMembresiaMostrador('m1', 'esencial', { operationId: 'op-1', metodo: 'cortesia', nota: 'x', referencia: 'f1', confirmarPerdida: true });
    expect(backendPost).toHaveBeenCalledWith('reception-activar-membresia', {
      usuario_id: 'm1', tier: 'esencial', operation_id: 'op-1', metodo: 'cortesia', confirmar_perdida: true, nota: 'x', referencia: 'f1'
    });
    const body = (backendPost as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>;
    for (const k of ['monto', 'monto_cobrado_centavos', 'precio_lista_centavos', 'moneda', 'actor', 'tenant_id']) expect(body).not.toHaveProperty(k);
  });
});

describe('clasificación de 409', () => {
  it('esPerdidaDeCreditos: solo el 409 que habla de créditos; los otros 409 devuelven null', () => {
    expect(esPerdidaDeCreditos(e409('El miembro perdería 8 crédito(s) al cambiar a este plan.'))).toBe(8);
    expect(esPerdidaDeCreditos(e409('El miembro perdería sus crédito(s) al cambiar a este plan.'))).toBe(1);
    expect(esPerdidaDeCreditos(e409('El miembro tiene una suscripción de Stripe vigente. Cancélala primero.'))).toBeNull();
    expect(esPerdidaDeCreditos(e409('Esta operación ya se registró con otros datos.'))).toBeNull();
    expect(esPerdidaDeCreditos(Object.assign(new Error('perdería 8 crédito(s)'), { status: 500 }))).toBeNull();
  });
  it('conflictoVentaMostrador distingue suscripción de Stripe y operación en conflicto', () => {
    expect(conflictoVentaMostrador(e409('El miembro tiene una suscripción de Stripe vigente.'))).toBe('suscripcion_stripe');
    expect(conflictoVentaMostrador(e409('Esta operación ya se registró con otros datos.'))).toBe('operacion_conflicto');
    expect(conflictoVentaMostrador(e409('perdería 8 crédito(s)'))).toBeNull();
    expect(conflictoVentaMostrador(new Error('red'))).toBeNull();
  });
});

describe('D9 en la UI (solo presentación)', () => {
  it('cortesía muestra 0; el resto el precio de lista', () => {
    expect(montoCobradoMostrador(85000, 'cortesia')).toBe(0);
    for (const m of METODOS_MOSTRADOR.filter((x) => x.valor !== 'cortesia')) expect(montoCobradoMostrador(85000, m.valor)).toBe(85000);
    expect(METODOS_MOSTRADOR.map((m) => m.valor)).toEqual(['efectivo', 'transferencia', 'terminal', 'cortesia']);
  });
  it('nuevaOperacionMostrador genera UUIDs distintos', () => {
    const a = nuevaOperacionMostrador();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(nuevaOperacionMostrador()).not.toBe(a);
  });
});
