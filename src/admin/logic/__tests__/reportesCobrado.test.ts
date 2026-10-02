import { describe, it, expect } from 'vitest';
import { calcularCobrado } from '../reportesCobrado';

const AHORA = new Date('2026-08-21T18:00:00Z');
const INICIO_MES = new Date('2026-08-01T07:00:00Z');
const INICIO_MES_ANT = new Date('2026-07-01T07:00:00Z');

const ev = (created_at: string, status: string, monto: number, tipo = 'invoice.paid') => ({
  created_at, status, monto_centavos: monto, stripe_event_type: tipo
});

describe('calcularCobrado', () => {
  it('suma lo cobrado del mes y del anterior por separado, y el % de variación', () => {
    const r = calcularCobrado(
      [ev('2026-08-05T10:00:00Z', 'succeeded', 85000), ev('2026-08-10T10:00:00Z', 'succeeded', 120000, 'payment_intent.succeeded'), ev('2026-07-15T10:00:00Z', 'succeeded', 100000)],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(205000);
    expect(r.cobradoMesAnteriorCentavos).toBe(100000);
    expect(r.cobradoMesPorcentaje).toBe(105);
    expect(r.porConcepto).toEqual([
      { concepto: 'Paquetes e invitados', centavos: 120000, cobros: 1 },
      { concepto: 'Mensualidades', centavos: 85000, cobros: 1 }
    ]);
  });

  it('reembolsos del mes (objetos Refund exactos) y cobros fallidos de 30 días no entran a lo cobrado', () => {
    const r = calcularCobrado(
      [ev('2026-08-05T10:00:00Z', 'succeeded', 85000), ev('2026-08-02T10:00:00Z', 'failed', 85000, 'invoice.payment_failed'), ev('2026-06-02T10:00:00Z', 'failed', 85000, 'invoice.payment_failed')],
      INICIO_MES, INICIO_MES_ANT, AHORA,
      [{ stripe_object_id: 're_1', monto_centavos: 85000, estado_proveedor: 'succeeded', fecha: '2026-08-06T10:00:00Z' }]
    );
    expect(r.cobradoMesCentavos).toBe(85000);
    expect(r.reembolsadoMesCentavos).toBe(85000);
    expect(r.reembolsosMes).toBe(1);
    expect(r.cobrosFallidos30d).toBe(1);
    expect(r.montoFallido30dCentavos).toBe(85000);
  });

  it('PKG-01G: dos parciales de 100 y 50 = 150, nunca 250; las filas `refunded` viejas de payment_events ya no cuentan', () => {
    const r = calcularCobrado(
      [ev('2026-08-05T10:00:00Z', 'succeeded', 85000), ev('2026-08-06T10:00:00Z', 'refunded', 15000, 'charge.refunded')],
      INICIO_MES, INICIO_MES_ANT, AHORA,
      [
        { stripe_object_id: 're_1', monto_centavos: 10000, estado_proveedor: 'succeeded', fecha: '2026-08-06T10:00:00Z' },
        { stripe_object_id: 're_2', monto_centavos: 5000, estado_proveedor: 'succeeded', fecha: '2026-08-07T10:00:00Z' },
        // El mismo objeto visto dos veces (dos eventos) cuenta una vez.
        { stripe_object_id: 're_2', monto_centavos: 5000, estado_proveedor: 'succeeded', fecha: '2026-08-07T10:00:00Z' },
        // Fallido/pendiente no cuenta.
        { stripe_object_id: 're_3', monto_centavos: 99900, estado_proveedor: 'failed', fecha: '2026-08-07T10:00:00Z' },
        { stripe_object_id: 're_4', monto_centavos: 99900, estado_proveedor: 'pending', fecha: '2026-08-07T10:00:00Z' },
        // Mes anterior no cuenta.
        { stripe_object_id: 're_5', monto_centavos: 7000, estado_proveedor: 'succeeded', fecha: '2026-07-07T10:00:00Z' }
      ]
    );
    expect(r.reembolsadoMesCentavos).toBe(15000);
    expect(r.reembolsosMes).toBe(2);
  });

  it('sin mes anterior → porcentaje null; sin eventos → ceros', () => {
    expect(calcularCobrado([ev('2026-08-05T10:00:00Z', 'succeeded', 1000)], INICIO_MES, INICIO_MES_ANT, AHORA).cobradoMesPorcentaje).toBeNull();
    const r = calcularCobrado([], INICIO_MES, INICIO_MES_ANT, AHORA);
    expect(r).toMatchObject({ cobradoMesCentavos: 0, cobradoMesAnteriorCentavos: 0, cobrosFallidos30d: 0, porConcepto: [] });
  });
});
