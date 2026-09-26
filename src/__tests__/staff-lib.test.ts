import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { esStaffActivo, esAdminActivo, puedeOperarSobre } from '../../netlify/functions/_lib/staff';

describe('_lib/staff — guards del caller', () => {
  it('esStaffActivo: admin o recepcionista con status activo', () => {
    expect(esStaffActivo({ rol: 'recepcionista', status: 'activo' })).toBe(true);
    expect(esStaffActivo({ rol: 'admin', status: 'activo' })).toBe(true);
  });

  it('esStaffActivo: un revocado/suspendido NO pasa aunque conserve el rol', () => {
    expect(esStaffActivo({ rol: 'recepcionista', status: 'revocado' })).toBe(false);
    expect(esStaffActivo({ rol: 'admin', status: 'suspendido' })).toBe(false);
    // Sin status en el select = no se pudo comprobar = no pasa.
    expect(esStaffActivo({ rol: 'admin' })).toBe(false);
  });

  it('esStaffActivo: miembro, null y undefined no pasan', () => {
    expect(esStaffActivo({ rol: 'miembro', status: 'activo' })).toBe(false);
    expect(esStaffActivo(null)).toBe(false);
    expect(esStaffActivo(undefined)).toBe(false);
  });

  it('esAdminActivo: solo admin activo', () => {
    expect(esAdminActivo({ rol: 'admin', status: 'activo' })).toBe(true);
    expect(esAdminActivo({ rol: 'recepcionista', status: 'activo' })).toBe(false);
    expect(esAdminActivo({ rol: 'admin', status: 'revocado' })).toBe(false);
  });

  it('puedeOperarSobre: recepción solo sobre miembros; admin sobre cualquiera', () => {
    expect(puedeOperarSobre({ rol: 'recepcionista' }, { rol: 'miembro' })).toBe(true);
    expect(puedeOperarSobre({ rol: 'recepcionista' }, { rol: 'admin' })).toBe(false);
    expect(puedeOperarSobre({ rol: 'recepcionista' }, { rol: 'recepcionista' })).toBe(false);
    expect(puedeOperarSobre({ rol: 'admin' }, { rol: 'admin' })).toBe(true);
  });
});

/**
 * Guardia de regresión: TODA function de staff valida al caller con estos
 * helpers (rol + status). Una function nueva que compare `caller.rol` a mano
 * vuelve a dejar entrar a un staff revocado — y este test la señala.
 */
describe('toda function de staff usa los guards de _lib/staff', () => {
  const DIR = resolve(__dirname, '../../netlify/functions');
  const fuentes = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => ({ nombre: d.name, ruta: resolve(DIR, d.name, 'index.ts') }))
    .filter((f) => existsSync(f.ruta))
    .map((f) => ({ ...f, src: readFileSync(f.ruta, 'utf8') }));

  // Los dos patrones con que se decidía el acceso a mano:
  //   if (!x || x.rol !== 'admin')          ·   if (!x || !ROLES.includes(x.rol))
  // (`body.rol` es validación de la entrada, no del caller: se excluye.)
  const aMano = /\|\|\s*(?!body\.)\w+\.rol\s*!==\s*'admin'\s*\)|\.includes\((?!body\.)\w+\.rol\)/;

  it('hay functions de staff en disco (si no, el test no prueba nada)', () => {
    expect(fuentes.filter((f) => /^(admin|reception)-/.test(f.nombre)).length).toBeGreaterThan(10);
  });

  it('ninguna function decide el acceso del caller comparando solo el rol', () => {
    const ofensoras = fuentes.filter((f) => aMano.test(f.src)).map((f) => f.nombre);
    expect(ofensoras).toEqual([]);
  });

  it('las functions admin-* y reception-* importan el guard', () => {
    const sinGuard = fuentes
      .filter((f) => /^(admin|reception|staff)-/.test(f.nombre))
      .filter((f) => !/from '\.\.\/_lib\/staff'/.test(f.src))
      .map((f) => f.nombre);
    expect(sinGuard).toEqual([]);
  });
});
