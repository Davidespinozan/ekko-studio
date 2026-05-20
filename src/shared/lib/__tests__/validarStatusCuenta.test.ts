import { describe, it, expect, vi } from 'vitest';
import { validarStatusCuenta, traducirErrorAuth } from '../validarStatusCuenta';

describe('validarStatusCuenta', () => {
  it('activo → permitido', () => {
    const r = validarStatusCuenta({ status: 'activo' });
    expect(r.permitido).toBe(true);
    expect(r.mensaje).toBeUndefined();
  });

  it('suspendido → bloqueado con mensaje', () => {
    const r = validarStatusCuenta({ status: 'suspendido' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/suspendida/i);
  });

  it('revocado → bloqueado con mensaje', () => {
    const r = validarStatusCuenta({ status: 'revocado' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/revocad/i);
  });

  it('cancelado → bloqueado con mensaje', () => {
    const r = validarStatusCuenta({ status: 'cancelado' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/cancelada/i);
  });

  it('pendiente_onboarding → bloqueado con mensaje', () => {
    const r = validarStatusCuenta({ status: 'pendiente_onboarding' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/pendiente de activación/i);
  });

  it('pendiente_pago → bloqueado con mensaje', () => {
    const r = validarStatusCuenta({ status: 'pendiente_pago' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/pendiente de pago/i);
  });

  it('status desconocido → bloquea defensivamente', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = validarStatusCuenta({ status: 'xyz_raro' });
    expect(r.permitido).toBe(false);
    expect(r.mensaje).toMatch(/no válido/i);
    spy.mockRestore();
  });

  it('NO valida bloqueado_hasta — un activo con bloqueo entra igual', () => {
    // bloqueado_hasta es penalización de no-show (restricción de reserva),
    // no gatea el login. Aunque se pase, el helper solo mira `status`.
    const r = validarStatusCuenta({
      status: 'activo',
      // @ts-expect-error — bloqueado_hasta ya no es parte de PerfilStatus
      bloqueado_hasta: '2099-01-01T00:00:00Z'
    });
    expect(r.permitido).toBe(true);
  });
});

describe('traducirErrorAuth', () => {
  it('credenciales inválidas', () => {
    expect(traducirErrorAuth('Invalid login credentials')).toBe(
      'Email o contraseña incorrectos.'
    );
  });

  it('email no confirmado', () => {
    expect(traducirErrorAuth('Email not confirmed')).toMatch(/no está confirmado/i);
  });

  it('rate limit / too many requests', () => {
    expect(traducirErrorAuth('Too many requests')).toMatch(/demasiados intentos/i);
    expect(traducirErrorAuth('rate limit exceeded')).toMatch(/demasiados intentos/i);
  });

  it('error de red', () => {
    expect(traducirErrorAuth('Failed to fetch')).toMatch(/sin conexión/i);
    expect(traducirErrorAuth('network error')).toMatch(/sin conexión/i);
  });

  it('fallback genérico — no expone el mensaje técnico crudo', () => {
    const crudo = 'PGRST500: internal jwt malformed at column 42';
    const traducido = traducirErrorAuth(crudo);
    expect(traducido).toBe(
      'No pudimos iniciar sesión. Intentá de nuevo o contactá al estudio.'
    );
    expect(traducido).not.toContain('jwt');
  });

  it('es case-insensitive', () => {
    expect(traducirErrorAuth('INVALID LOGIN CREDENTIALS')).toBe(
      'Email o contraseña incorrectos.'
    );
  });
});
