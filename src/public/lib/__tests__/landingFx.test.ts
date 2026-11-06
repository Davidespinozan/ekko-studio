// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  instalarBrilloTarjetas,
  instalarProgresoScroll,
  instalarSpotlight,
  navSolida,
  partirPalabras,
  posicionRelativa,
  progresoScroll,
  sinFlecha
} from '../landingFx';

/** Fase 1 premium · efectos de la landing: funciones puras e instaladores con limpieza. */
describe('landingFx', () => {
  it('partirPalabras separa por espacios y tolera vacío', () => {
    expect(partirPalabras('Tu estudio.  Tu  contenido.')).toEqual(['Tu', 'estudio.', 'Tu', 'contenido.']);
    expect(partirPalabras('')).toEqual([]);
    expect(partirPalabras(null)).toEqual([]);
  });

  it('sinFlecha quita solo la flecha final del texto del botón', () => {
    expect(sinFlecha('Ver planes →')).toBe('Ver planes');
    expect(sinFlecha('Contáctanos por WhatsApp ->')).toBe('Contáctanos por WhatsApp');
    expect(sinFlecha('Ver → planes')).toBe('Ver → planes');
    expect(sinFlecha(null)).toBe('');
  });

  it('navSolida: solo después de 24 px', () => {
    expect(navSolida(0)).toBe(false);
    expect(navSolida(24)).toBe(false);
    expect(navSolida(25)).toBe(true);
  });

  it('progresoScroll: 0–1, acotado, y 0 si no hay nada que desplazar', () => {
    expect(progresoScroll(0, 3000, 1000)).toBe(0);
    expect(progresoScroll(1000, 3000, 1000)).toBe(0.5);
    expect(progresoScroll(9999, 3000, 1000)).toBe(1);
    expect(progresoScroll(100, 800, 1000)).toBe(0);
  });

  it('posicionRelativa resta el origen de la caja', () => {
    expect(posicionRelativa({ clientX: 150, clientY: 80 }, { left: 100, top: 30 })).toEqual({ x: 50, y: 50 });
  });

  it('instalarBrilloTarjetas: la tarjeta bajo el cursor recibe --x/--y; las demás no', () => {
    const raiz = document.createElement('div');
    const tarjeta = document.createElement('div');
    tarjeta.className = 'ek-glow';
    const hijo = document.createElement('span');
    tarjeta.appendChild(hijo);
    const otra = document.createElement('div');
    otra.className = 'ek-glow';
    raiz.append(tarjeta, otra);
    document.body.appendChild(raiz);
    tarjeta.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 100, right: 110, bottom: 120, x: 10, y: 20, toJSON: () => ({}) });
    const quitar = instalarBrilloTarjetas(raiz);
    hijo.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 70 }));
    expect(tarjeta.style.getPropertyValue('--x')).toBe('50px');
    expect(tarjeta.style.getPropertyValue('--y')).toBe('50px');
    expect(otra.style.getPropertyValue('--x')).toBe('');
    quitar();
    hijo.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 90 }));
    expect(tarjeta.style.getPropertyValue('--x')).toBe('50px');
    raiz.remove();
  });

  it('instalarSpotlight: el hero recibe --mx/--my y se limpia', () => {
    const hero = document.createElement('section');
    hero.getBoundingClientRect = () => ({ left: 0, top: 100, width: 800, height: 600, right: 800, bottom: 700, x: 0, y: 100, toJSON: () => ({}) });
    const quitar = instalarSpotlight(hero);
    hero.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 400 }));
    expect(hero.style.getPropertyValue('--mx')).toBe('300px');
    expect(hero.style.getPropertyValue('--my')).toBe('300px');
    quitar();
    expect(instalarSpotlight(null)).toBeTypeOf('function');
  });

  it('instalarProgresoScroll pinta la barra con el avance y se limpia', () => {
    const barra = document.createElement('div');
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    Object.defineProperty(window, 'scrollY', { value: 500, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1000, writable: true, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    const quitar = instalarProgresoScroll(barra);
    expect(barra.style.transform).toBe('scaleX(0.5000)');
    Object.defineProperty(window, 'scrollY', { value: 1000, writable: true, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(barra.style.transform).toBe('scaleX(1.0000)');
    quitar();
    raf.mockRestore();
    expect(instalarProgresoScroll(null)).toBeTypeOf('function');
  });
});
