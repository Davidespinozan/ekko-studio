import { describe, it, expect } from 'vitest';
import { avisoMembresia } from '../avisoMembresia';

describe('avisoMembresia', () => {
  it('membresía en regla o estado no informado → sin aviso', () => {
    expect(avisoMembresia('ok')).toBeNull();
    expect(avisoMembresia(undefined)).toBeNull();
    expect(avisoMembresia(null)).toBeNull();
    expect(avisoMembresia('')).toBeNull();
  });

  it('cada estado que devuelve el RPC tiene su aviso', () => {
    expect(avisoMembresia('sin_membresia')).toMatch(/Sin membresía vigente/);
    expect(avisoMembresia('vencida')).toMatch(/VENCIDA/);
    expect(avisoMembresia('pago_pendiente')).toMatch(/Pago PENDIENTE/);
  });

  it('cuenta_* nombra el status de la cuenta', () => {
    expect(avisoMembresia('cuenta_suspendido')).toMatch(/Cuenta suspendido/);
  });

  it('un estado desconocido NUNCA pasa en silencio', () => {
    expect(avisoMembresia('algo_nuevo')).toMatch(/no está vigente/);
  });
});

describe('avisoMembresia · F2 · R1 (restricciones de cuenta)', () => {
  it('revocado y sancionado se anuncian como excepción registrada, no como ingreso normal', () => {
    expect(avisoMembresia('cuenta_revocado')).toMatch(/ACCESO REVOCADO.*no puede entrar/);
    expect(avisoMembresia('cuenta_sancionada')).toMatch(/SANCIONADA.*excepción/);
  });
});
