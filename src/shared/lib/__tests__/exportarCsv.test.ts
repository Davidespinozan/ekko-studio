import { describe, it, expect } from 'vitest';
import { construirCsv } from '../exportarCsv';

describe('construirCsv', () => {
  it('vacío → cadena vacía', () => {
    expect(construirCsv([])).toBe('');
  });

  it('usa las llaves de la primera fila como encabezados y antepone BOM', () => {
    const csv = construirCsv([{ nombre: 'Ana', email: 'ana@x.mx' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.replace('﻿', '')).toBe('"nombre","email"\r\n"Ana","ana@x.mx"');
  });

  it('escapa comillas, comas y saltos de línea', () => {
    const csv = construirCsv([{ n: 'Dice "hola", y\nsigue' }]);
    expect(csv).toContain('"Dice ""hola"", y\nsigue"');
  });

  it('columnas con label y formateo', () => {
    const csv = construirCsv(
      [{ monto_centavos: 85000, creada_at: '2026-08-21T18:00:00Z' }],
      [
        { key: 'monto_centavos', label: 'Monto (MXN)', valor: (f) => (f.monto_centavos / 100).toFixed(2) },
        { key: 'creada_at', label: 'Fecha' }
      ]
    );
    expect(csv.replace('﻿', '')).toBe('"Monto (MXN)","Fecha"\r\n"850.00","2026-08-21T18:00:00Z"');
  });

  it('null/undefined → celda vacía', () => {
    expect(construirCsv([{ a: null, b: undefined }]).replace('﻿', '')).toBe('"a","b"\r\n"",""');
  });
});
