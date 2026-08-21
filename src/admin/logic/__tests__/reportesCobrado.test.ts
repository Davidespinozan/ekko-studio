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

  it('reembolsos del mes y cobros fallidos de 30 días no entran a lo cobrado', () => {
    const r = calcularCobrado(
      [ev('2026-08-05T10:00:00Z', 'succeeded', 85000), ev('2026-08-06T10:00:00Z', 'refunded', 85000, 'charge.refunded'), ev('2026-08-02T10:00:00Z', 'failed', 85000, 'invoice.payment_failed'), ev('2026-06-02T10:00:00Z', 'failed', 85000, 'invoice.payment_failed')],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(85000);
    expect(r.reembolsadoMesCentavos).toBe(85000);
    expect(r.cobrosFallidos30d).toBe(1);
    expect(r.montoFallido30dCentavos).toBe(85000);
  });

  it('sin mes anterior → porcentaje null; sin eventos → ceros', () => {
    expect(calcularCobrado([ev('2026-08-05T10:00:00Z', 'succeeded', 1000)], INICIO_MES, INICIO_MES_ANT, AHORA).cobradoMesPorcentaje).toBeNull();
    const r = calcularCobrado([], INICIO_MES, INICIO_MES_ANT, AHORA);
    expect(r).toMatchObject({ cobradoMesCentavos: 0, cobradoMesAnteriorCentavos: 0, cobrosFallidos30d: 0, porConcepto: [] });
  });
});
