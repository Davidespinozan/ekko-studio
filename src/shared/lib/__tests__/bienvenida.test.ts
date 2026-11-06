import { describe, it, expect } from 'vitest';
import { etiquetaRol, fechaLarga, inicialDe, nombrePersona, resumenDelDia, saludo, saludoPorHora } from '../bienvenida';

/** Bienvenida del panel: saludo por hora del estudio, nombre de persona y resumen honesto del día. */
describe('bienvenida', () => {
  it('saludoPorHora: mañana 5–11, tarde 12–18, noche el resto', () => {
    expect([4, 5, 11, 12, 18, 19, 0].map(saludoPorHora)).toEqual([
      'Buenas noches', 'Buenos días', 'Buenos días', 'Buenas tardes', 'Buenas tardes', 'Buenas noches', 'Buenas noches'
    ]);
  });

  it('saludo usa la hora del ESTUDIO (America/Mazatlan), no la del navegador', () => {
    // 22:00 UTC = 15:00 en Mazatlán → tarde; 13:00 UTC = 06:00 → mañana.
    expect(saludo('david espinoza', new Date('2026-11-05T22:00:00Z'))).toBe('Buenas tardes, David');
    expect(saludo('david espinoza', new Date('2026-11-05T13:00:00Z'))).toBe('Buenos días, David');
    expect(saludo(null, new Date('2026-11-06T04:00:00Z'))).toBe('Buenas noches');
  });

  it('nombrePersona: nombre de pila con mayúscula; cuentas de servicio o correos → null', () => {
    expect(nombrePersona('ana lópez')).toBe('Ana');
    expect(nombrePersona('  MARÍA  ')).toBe('María');
    expect(nombrePersona('recepcion')).toBeNull();
    expect(nombrePersona('admin ekko')).toBeNull();
    expect(nombrePersona('ana@ekko.test')).toBeNull();
    expect(nombrePersona('')).toBeNull();
    expect(inicialDe('Ana')).toBe('A');
    expect(inicialDe(null)).toBe('E');
  });

  it('etiquetaRol y fechaLarga', () => {
    expect(etiquetaRol('admin')).toBe('Administración');
    expect(etiquetaRol('recepcionista')).toBe('Recepción');
    expect(etiquetaRol('otro')).toBe('Equipo');
    expect(fechaLarga(new Date('2026-11-05T22:00:00Z'))).toMatch(/jueves,? 5 de noviembre/);
  });

  it('resumenDelDia: lo pendiente manda y es urgente; si no, las sesiones (y check‑ins); si nada, lo dice', () => {
    expect(resumenDelDia({ sesionesHoy: 3, pendientes: 1 })).toEqual({ texto: 'Tienes 1 pendiente que requiere tu atención.', urgente: true });
    expect(resumenDelDia({ sesionesHoy: 0, pendientes: 4 }).texto).toBe('Tienes 4 pendientes que requieren tu atención.');
    expect(resumenDelDia({ sesionesHoy: 1 })).toEqual({ texto: 'Hoy hay 1 sesión agendada.', urgente: false });
    expect(resumenDelDia({ sesionesHoy: 3, checkIns: 1 }).texto).toBe('Hoy hay 3 sesiones agendadas y 1 check‑in hecho.');
    expect(resumenDelDia({ sesionesHoy: 2, checkIns: 0 }).texto).toBe('Hoy hay 2 sesiones agendadas y 0 check‑ins hechos.');
    expect(resumenDelDia({ sesionesHoy: 0 }).texto).toMatch(/no hay sesiones agendadas/);
  });
});
