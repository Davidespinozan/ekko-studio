import { describe, it, expect } from 'vitest';
import {
  MEMBRESIAS_DEFAULT,
  ESTUDIOS_DEFAULT,
  COMO_FUNCIONA_DEFAULT,
  FAQ_DEFAULT,
  ESTUDIO_MODAL_DEFAULT,
  parseMembresias,
  parseEstudios,
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

  describe('parseEstudios', () => {
    it('sin config → defaults genéricos (no atados a un número)', () => {
      expect(parseEstudios(null)).toEqual(ESTUDIOS_DEFAULT);
    });
    it('campo lleno gana, vacío cae al default', () => {
      const r = parseEstudios({ titulo: 'Mis salas', subtitulo: '' });
      expect(r.titulo).toBe('Mis salas');
      expect(r.subtitulo).toBe(ESTUDIOS_DEFAULT.subtitulo);
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

  // Invariantes de coherencia del copy con el modelo de EKKO (membresía + créditos).
  // Guarda contra regresiones al lenguaje del gimnasio (STRYV) o al modelo "solo
  // créditos" que contradecía las membresías mensuales.
  describe('coherencia del copy con el modelo EKKO', () => {
    const faqTexto = FAQ_DEFAULT.items.map((i) => `${i.q} ${i.a}`).join(' ').toLowerCase();
    const pasosTexto = COMO_FUNCIONA_DEFAULT.pasos.map((p) => `${p.titulo} ${p.texto}`).join(' ').toLowerCase();

    it('no usa voseo (español neutral mexicano)', () => {
      const voseo = /\b(traés|elegí|reservá|mostrá|tenés|podés|querés)\b/;
      expect(voseo.test(faqTexto)).toBe(false);
      expect(voseo.test(pasosTexto)).toBe(false);
    });

    it('la FAQ no niega las mensualidades (ya conviven membresía + paquete)', () => {
      expect(faqTexto).not.toContain('sin mensualidades');
    });

    it('la FAQ cubre AMBOS modelos: membresía y créditos/paquete', () => {
      expect(faqTexto).toContain('membresía');
      expect(faqTexto).toMatch(/crédito|paquete/);
    });

    it('la entrega es MP4 (no "trae tu disco duro")', () => {
      expect(faqTexto).toContain('mp4');
      expect(faqTexto).not.toContain('disco duro');
    });

    it('no hardcodea el costo en créditos por estudio (es configurable)', () => {
      expect(faqTexto).not.toContain('cuestan 1 crédito');
    });

    it('membresías sin permanencia: no exige compromiso mínimo ni 6 meses', () => {
      expect(faqTexto).not.toMatch(/contrato mínimo|compromiso mínimo|permanencia mínima|6 meses|seis meses/);
    });
  });

  describe('parseEstudioModal', () => {
    it('sin config → default (#membresias, baja a la sección de planes)', () => {
      expect(parseEstudioModal(null)).toEqual(ESTUDIO_MODAL_DEFAULT);
      expect(ESTUDIO_MODAL_DEFAULT.cta_link).toBe('#membresias');
    });
    it('valores propios ganan', () => {
      const r = parseEstudioModal({ cta_texto: 'Reservar', cta_link: '#membresias' });
      expect(r).toEqual({ cta_texto: 'Reservar', cta_link: '#membresias' });
    });
  });
});
