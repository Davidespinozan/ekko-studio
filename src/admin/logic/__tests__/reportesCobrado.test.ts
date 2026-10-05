import { describe, it, expect } from 'vitest';
import { calcularCobrado, conceptoDeOrigen, type LibroFila } from '../reportesCobrado';

/**
 * R2-B (PKG-01N): el reporte "Cobrado" se calcula sobre el libro económico
 * (`v_libro_economico`). La clasificación (firme / sin_resolver / excluido, monto
 * exacto de cada reversal, no doble conteo) se prueba contra Postgres en
 * src/__tests__/db/r2b-libro-economico.db.test.ts; aquí, la agregación.
 */

const AHORA = new Date('2026-08-21T18:00:00Z');
const INICIO_MES = new Date('2026-08-01T07:00:00Z');
const INICIO_MES_ANT = new Date('2026-07-01T07:00:00Z');

const cobro = (ocurrido_at: string, monto: number, origen = 'suscripcion_renovacion', extra: Partial<LibroFila> = {}): LibroFila => ({
  clase: 'cobro', origen_negocio: origen, canal: 'app', moneda: 'mxn', monto_centavos: monto,
  efecto_neto_centavos: monto, estado_evidencia: 'firme', ocurrido_at, ...extra
});
const rev = (ocurrido_at: string, monto: number, estado = 'firme', clase = 'reembolso'): LibroFila => ({
  clase, origen_negocio: 'paquete', canal: 'app', moneda: 'mxn', monto_centavos: monto,
  efecto_neto_centavos: estado === 'firme' ? -monto : 0, estado_evidencia: estado, ocurrido_at
});

describe('calcularCobrado (libro económico)', () => {
  it('bruto del mes y del anterior por separado, % de variación y desglose por concepto (incluye mostrador)', () => {
    const r = calcularCobrado(
      [
        cobro('2026-08-05T10:00:00Z', 85000),
        cobro('2026-08-10T10:00:00Z', 120000, 'paquete'),
        cobro('2026-08-11T10:00:00Z', 85000, 'venta_mostrador', { canal: 'mostrador_efectivo' }),
        cobro('2026-08-12T10:00:00Z', 20000, 'invitados_extra'),
        cobro('2026-07-15T10:00:00Z', 100000)
      ],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(310000);
    expect(r.cobradoMesAnteriorCentavos).toBe(100000);
    expect(r.cobradoMesPorcentaje).toBe(210);
    expect(r.netoMesCentavos).toBe(310000);
    expect(r.porConcepto).toEqual([
      { concepto: 'Paquetes', centavos: 120000, cobros: 1 },
      { concepto: 'Mensualidades', centavos: 85000, cobros: 1 },
      { concepto: 'Mostrador', centavos: 85000, cobros: 1 },
      { concepto: 'Invitados extra', centavos: 20000, cobros: 1 }
    ]);
  });

  it('neto = bruto − reversales firmes; parciales suman; pendiente, anulado y disputa abierta no restan', () => {
    const r = calcularCobrado(
      [
        cobro('2026-08-05T10:00:00Z', 100000),
        rev('2026-08-06T10:00:00Z', 10000),
        rev('2026-08-07T10:00:00Z', 5000),
        rev('2026-08-07T10:00:00Z', 99900, 'anulado'),
        rev('2026-08-07T10:00:00Z', 99900, 'pendiente'),
        rev('2026-08-08T10:00:00Z', 100000, 'en_disputa', 'disputa'),
        rev('2026-07-07T10:00:00Z', 7000) // mes anterior: no cuenta en este mes
      ],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(100000);
    expect(r.reversadoMesCentavos).toBe(15000);
    expect(r.reversalesMes).toBe(2);
    expect(r.netoMesCentavos).toBe(85000);
    expect(r.enDisputaMesCentavos).toBe(100000);
  });

  it('disputa perdida resta como un reversal firme', () => {
    const r = calcularCobrado(
      [cobro('2026-08-05T10:00:00Z', 100000), rev('2026-08-09T10:00:00Z', 100000, 'firme', 'disputa')],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r).toMatchObject({ reversadoMesCentavos: 100000, netoMesCentavos: 0 });
  });

  it('sin_resolver y excluido no entran al bruto ni al neto; lo sin resolver se reporta aparte', () => {
    const r = calcularCobrado(
      [
        cobro('2026-08-05T10:00:00Z', 100000),
        cobro('2026-08-05T11:00:00Z', 100000, 'desconocido', { estado_evidencia: 'sin_resolver', efecto_neto_centavos: 0 }),
        cobro('2026-08-05T12:00:00Z', 150000, 'desconocido', { estado_evidencia: 'excluido', efecto_neto_centavos: 0 }),
        rev('2026-08-06T10:00:00Z', 25000, 'sin_resolver')
      ],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(100000);
    expect(r.netoMesCentavos).toBe(100000);
    expect(r.reversadoMesCentavos).toBe(0);
    expect(r.sinResolverMes).toBe(2);
    expect(r.sinResolverMesCentavos).toBe(125000);
  });

  it('cortesía no suma; otra moneda no se mezcla y se avisa', () => {
    const r = calcularCobrado(
      [
        cobro('2026-08-05T10:00:00Z', 85000),
        { ...cobro('2026-08-05T10:00:00Z', 0, 'cortesia'), clase: 'cortesia' },
        cobro('2026-08-06T10:00:00Z', 5000, 'paquete', { moneda: 'usd' })
      ],
      INICIO_MES, INICIO_MES_ANT, AHORA
    );
    expect(r.cobradoMesCentavos).toBe(85000);
    expect(r.otrasMonedas).toEqual(['usd']);
  });

  it('cobros fallidos de 30 días: se cuentan aparte y no entran a lo cobrado', () => {
    const r = calcularCobrado(
      [cobro('2026-08-05T10:00:00Z', 85000)], INICIO_MES, INICIO_MES_ANT, AHORA,
      [{ created_at: '2026-08-02T10:00:00Z', monto_centavos: 85000 }, { created_at: '2026-06-02T10:00:00Z', monto_centavos: 85000 }]
    );
    expect(r.cobradoMesCentavos).toBe(85000);
    expect(r.cobrosFallidos30d).toBe(1);
    expect(r.montoFallido30dCentavos).toBe(85000);
  });

  it('sin mes anterior → porcentaje null; sin filas → ceros', () => {
    expect(calcularCobrado([cobro('2026-08-05T10:00:00Z', 1000)], INICIO_MES, INICIO_MES_ANT, AHORA).cobradoMesPorcentaje).toBeNull();
    const r = calcularCobrado([], INICIO_MES, INICIO_MES_ANT, AHORA);
    expect(r).toMatchObject({ cobradoMesCentavos: 0, cobradoMesAnteriorCentavos: 0, netoMesCentavos: 0, cobrosFallidos30d: 0, porConcepto: [], otrasMonedas: [] });
  });

  it('conceptos legibles por origen de negocio', () => {
    expect(conceptoDeOrigen('suscripcion_alta')).toBe('Mensualidades');
    expect(conceptoDeOrigen('cambio_de_plan')).toBe('Cambios de plan');
    expect(conceptoDeOrigen('lo-que-sea')).toBe('Otros');
  });
});
