import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — módulo .mjs de scripts/, sin tipos.
import { EVENTOS_WEBHOOK } from '../../scripts/stripe-eventos.mjs';

/**
 * Paridad eventos suscritos ↔ eventos que el código maneja.
 *
 * `scripts/stripe-setup-webhooks.mjs` SINCRONIZA el endpoint de Stripe con
 * EVENTOS_WEBHOOK: un evento con `case` en clasificarEvento pero fuera de la
 * lista nunca llega (así estuvo `charge.refunded`: handler escrito, reembolsos
 * que jamás se registraron). Y uno en la lista sin `case` es ruido que se paga.
 */

const ROOT = resolve(__dirname, '../..');
const leer = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function casesDeClasificarEvento(): string[] {
  const src = leer('netlify/functions/_lib/stripe.ts');
  const inicio = src.indexOf('export function clasificarEvento');
  expect(inicio).toBeGreaterThan(-1);
  // Los eventos de Stripe siempre llevan punto ('invoice.paid'); los `case` de
  // status de suscripción ('active', 'past_due') no.
  return [...src.slice(inicio).matchAll(/case '([a-z_]+(?:\.[a-z_]+)+)'/g)].map((m) => m[1]).sort();
}

describe('webhook de Stripe — eventos suscritos = eventos manejados', () => {
  it('clasificarEvento tiene cases (si no, el test no prueba nada)', () => {
    expect(casesDeClasificarEvento().length).toBeGreaterThan(5);
  });

  it('la lista canónica coincide exactamente con los case de clasificarEvento', () => {
    expect([...(EVENTOS_WEBHOOK as string[])].sort()).toEqual(casesDeClasificarEvento());
  });

  it('incluye charge.refunded (los reembolsos deben llegar)', () => {
    expect(EVENTOS_WEBHOOK).toContain('charge.refunded');
  });

  it('los dos scripts usan la lista canónica, sin copias a mano', () => {
    for (const script of ['scripts/stripe-setup-webhooks.mjs', 'scripts/stripe-check.mjs']) {
      const src = leer(script);
      expect(src).toMatch(/from '\.\/stripe-eventos\.mjs'/);
      expect(src).not.toMatch(/'invoice\.paid'/);
    }
  });
});
