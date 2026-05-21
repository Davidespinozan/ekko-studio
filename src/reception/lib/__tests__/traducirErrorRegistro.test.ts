import { describe, it, expect } from 'vitest';
import { traducirErrorRegistro } from '../traducirErrorRegistro';

describe('traducirErrorRegistro', () => {
  it('email duplicado → mensaje claro (varias variantes)', () => {
    expect(traducirErrorRegistro('Ya existe una cuenta con ese email')).toBe(
      'Ya existe una cuenta con ese email.'
    );
    expect(traducirErrorRegistro('User already registered')).toBe(
      'Ya existe una cuenta con ese email.'
    );
    expect(traducirErrorRegistro('email already exists')).toBe(
      'Ya existe una cuenta con ese email.'
    );
  });

  it('contraseña corta → mensaje de mínimo 8 caracteres', () => {
    expect(traducirErrorRegistro('La contraseña debe tener al menos 8 caracteres')).toBe(
      'La contraseña debe tener al menos 8 caracteres.'
    );
  });

  it('falta de permiso → mensaje de permiso', () => {
    expect(traducirErrorRegistro('Solo recepción o admin pueden registrar miembros')).toBe(
      'No tenés permiso para registrar miembros.'
    );
  });

  it('sesión / token inválido → mensaje de sesión', () => {
    expect(traducirErrorRegistro('Token inválido')).toBe(
      'Tu sesión expiró. Iniciá sesión de nuevo.'
    );
  });

  it('error técnico crudo → fallback genérico, NUNCA expone el crudo', () => {
    const crudo = 'duplicate key value violates unique constraint "usuarios_pkey"';
    const out = traducirErrorRegistro(crudo);
    expect(out).toBe('No se pudo registrar al miembro. Intentá de nuevo.');
    expect(out).not.toContain('constraint');
  });

  it('mensaje vacío → fallback genérico', () => {
    expect(traducirErrorRegistro('')).toBe('No se pudo registrar al miembro. Intentá de nuevo.');
  });
});
