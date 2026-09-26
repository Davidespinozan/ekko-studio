import { describe, it, expect } from 'vitest';
import { coincideBusqueda, pareceTelefono } from '../buscarEnPadron';

const ANA = { nombre: 'Ana María Núñez', email: 'ana@ekko.mx', folio: 'EK-0042', telefono: '+52 (667) 123-4567' };

describe('coincideBusqueda · mostrador', () => {
  it('nombre sin acentos ni mayúsculas', () => {
    expect(coincideBusqueda(ANA, 'nunez')).toBe(true);
    expect(coincideBusqueda(ANA, 'ANA MARIA')).toBe(true);
    expect(coincideBusqueda(ANA, 'pedro')).toBe(false);
  });

  it('email y folio', () => {
    expect(coincideBusqueda(ANA, 'ana@ekko')).toBe(true);
    expect(coincideBusqueda(ANA, 'ek-0042')).toBe(true);
  });

  it('teléfono: últimos dígitos, con o sin formato', () => {
    expect(coincideBusqueda(ANA, '4567')).toBe(true);
    expect(coincideBusqueda(ANA, '667 123')).toBe(true);
    expect(coincideBusqueda(ANA, '+526671234567')).toBe(true);
    expect(coincideBusqueda(ANA, '9999')).toBe(false);
  });

  it('sin teléfono guardado, una consulta numérica no truena ni coincide', () => {
    expect(coincideBusqueda({ ...ANA, telefono: null }, '4567')).toBe(false);
  });

  it('un folio numérico sigue encontrándose aunque parezca teléfono', () => {
    expect(coincideBusqueda({ nombre: 'X', folio: '20260921', telefono: null }, '0921')).toBe(true);
  });

  it('consulta vacía coincide con todo', () => {
    expect(coincideBusqueda(ANA, '   ')).toBe(true);
  });

  it('pareceTelefono', () => {
    expect(pareceTelefono('12')).toBe(false);
    expect(pareceTelefono('123')).toBe(true);
    expect(pareceTelefono('ana 123')).toBe(false);
  });
});
