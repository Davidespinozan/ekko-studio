import { describe, it, expect } from 'vitest';
import { telWhatsAppMx, waLink } from '../whatsapp';

describe('telWhatsAppMx', () => {
  it('10 dígitos locales → prefija 52', () => {
    expect(telWhatsAppMx('6671234567')).toBe('526671234567');
  });
  it('con espacios/guiones/paréntesis → limpia y prefija', () => {
    expect(telWhatsAppMx('(667) 123-4567')).toBe('526671234567');
  });
  it('ya con 52 → se respeta', () => {
    expect(telWhatsAppMx('526671234567')).toBe('526671234567');
    expect(telWhatsAppMx('+52 667 123 4567')).toBe('526671234567');
  });
  it('formato legado 521… → normaliza a 52…', () => {
    expect(telWhatsAppMx('5216671234567')).toBe('526671234567');
  });
  it('null/vacío/corto → null', () => {
    expect(telWhatsAppMx(null)).toBeNull();
    expect(telWhatsAppMx('')).toBeNull();
    expect(telWhatsAppMx('12345')).toBeNull();
  });
});

describe('waLink', () => {
  it('arma el enlace con mensaje URL-encoded', () => {
    expect(waLink('526671234567', '¡Hola! ¿vienes?')).toBe(
      'https://wa.me/526671234567?text=%C2%A1Hola!%20%C2%BFvienes%3F'
    );
  });
});
