import { describe, it, expect } from 'vitest';
import {
  MEMBRESIAS_DEFAULT,
  COMO_FUNCIONA_DEFAULT,
  FAQ_DEFAULT,
  ESTUDIO_MODAL_DEFAULT,
  parseMembresias,
  parseComoFunciona,
  parseFaq,
  parseEstudioModal
} from '../landingDefaults';

describe('landingDefaults parsers', () => {
  describe('parseMembresias', () => {
    it('sin config → defaults', () => {
      expect(parseMembresias(null)).toEqual(MEMBRESIAS_DEFAULT);
      expect(parseMembresias(undefined)).toEqual(MEMBRESIAS_DEFAULT);
      expect(parseMembresias('nope')).toEqual(MEMBRESIAS_DEFAULT);
    });
    it('campo vacío cae al default; campo lleno gana', () => {
      const r = parseMembresias({ titulo: 'Mis planes', eyebrow: '   ' });
      expect(r.titulo).toBe('Mis planes');
      expect(r.eyebrow).toBe(MEMBRESIAS_DEFAULT.eyebrow); // '   ' se ignora
      expect(r.titulo_accent).toBe(MEMBRESIAS_DEFAULT.titulo_accent);
    });
  });

  describe('parseComoFunciona', () => {
    it('sin config → defaults (con 3 pasos)', () => {
      expect(parseComoFunciona(null)).toEqual(COMO_FUNCIONA_DEFAULT);
    });
    it('array de pasos guardado gana, aunque sea vacío (decisión del admin)', () => {
      expect(parseComoFunciona({ pasos: [] }).pasos).toEqual([]);
    });
    it('normaliza cada paso a {titulo, texto} strings', () => {
      const r = parseComoFunciona({ pasos: [{ titulo: 'A' }, { texto: 'B', extra: 1 }] });
      expect(r.pasos).toEqual([
        { titulo: 'A', texto: '' },
        { titulo: '', texto: 'B' }
      ]);
    });
    it('pasos ausente → usa los 3 default', () => {
      expect(parseComoFunciona({ titulo: 'X' }).pasos).toHaveLength(3);
    });
  });

  describe('parseFaq', () => {
    it('sin config → defaults', () => {
      expect(parseFaq(null)).toEqual(FAQ_DEFAULT);
    });
    it('items guardado gana; normaliza a {q, a}', () => {
      const r = parseFaq({ items: [{ q: '¿?' }] });
      expect(r.items).toEqual([{ q: '¿?', a: '' }]);
    });
    it('items vacío = sin preguntas (respeta al admin)', () => {
      expect(parseFaq({ items: [] }).items).toEqual([]);
    });
  });

  describe('parseEstudioModal', () => {
    it('sin config → default (/signup, sin /mes)', () => {
      expect(parseEstudioModal(null)).toEqual(ESTUDIO_MODAL_DEFAULT);
      expect(ESTUDIO_MODAL_DEFAULT.cta_link).toBe('/signup');
    });
    it('valores propios ganan', () => {
      const r = parseEstudioModal({ cta_texto: 'Reservar', cta_link: '#membresias' });
      expect(r).toEqual({ cta_texto: 'Reservar', cta_link: '#membresias' });
    });
  });
});
