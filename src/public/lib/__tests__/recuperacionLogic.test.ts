import { describe, it, expect } from 'vitest';
import {
  validarEmail,
  validarPassword,
  validarNuevaContrasena,
  traducirErrorRecuperacion
} from '../recuperacionLogic';

describe('validarEmail', () => {
  it('acepta emails válidos (con espacios alrededor)', () => {
    expect(validarEmail('  ana@cravia.mx ')).toEqual({ ok: true });
  });
  it('rechaza vacío y formatos rotos', () => {
    expect(validarEmail('')).toMatchObject({ ok: false });
    expect(validarEmail('ana@')).toMatchObject({ ok: false });
    expect(validarEmail('ana cravia.mx')).toMatchObject({ ok: false });
  });
});

describe('validarPassword / validarNuevaContrasena', () => {
  it('exige 8+ caracteres con letra y número', () => {
    expect(validarPassword('corta1')).toMatchObject({ ok: false });
    expect(validarPassword('sololetras')).toMatchObject({ ok: false });
    expect(validarPassword('12345678')).toMatchObject({ ok: false });
    expect(validarPassword('Segura123')).toEqual({ ok: true });
  });
  it('la confirmación debe coincidir', () => {
    expect(validarNuevaContrasena('Segura123', 'Segura124')).toEqual({ ok: false, error: 'Las contraseñas no coinciden.' });
    expect(validarNuevaContrasena('Segura123', 'Segura123')).toEqual({ ok: true });
  });
  it('la fuerza se evalúa antes que la coincidencia', () => {
    expect(validarNuevaContrasena('corta', 'corta')).toMatchObject({ ok: false, error: expect.stringMatching(/8 caracteres/) });
  });
});

describe('traducirErrorRecuperacion', () => {
  it('enlace expirado/inválido', () => {
    expect(traducirErrorRecuperacion('Token has expired or is invalid')).toMatch(/expiró/);
    expect(traducirErrorRecuperacion('Auth session missing!')).toMatch(/expiró/);
  });
  it('misma contraseña que la anterior (antes que "invalid")', () => {
    expect(traducirErrorRecuperacion('New password should be different from the old password.')).toMatch(/distinta/);
  });
  it('débil, rate limit y genérico en español', () => {
    expect(traducirErrorRecuperacion('Password is too weak')).toMatch(/fuerte/);
    expect(traducirErrorRecuperacion('Too many requests')).toMatch(/Demasiados/);
    expect(traducirErrorRecuperacion('something else')).toMatch(/Intenta de nuevo/);
  });
});
