import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guardia de regresión: los crons se declaran en netlify.toml con la sintaxis
 * REAL de Netlify (`[functions."nombre"]` + `schedule`). El bloque
 * `[[scheduled_functions]]` no existe: Netlify lo ignora en silencio y ningún
 * cron corre (EKKO estuvo así desde el día 1; SALA lo descubrió en producción).
 *
 * Regla: toda carpeta `netlify/functions/cron-*` debe tener su `schedule`.
 */

const ROOT = resolve(__dirname, '../..');
// Sin comentarios: el propio toml documenta la sintaxis vieja como advertencia.
const toml = readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

function cronsEnDisco(): string[] {
  return readdirSync(resolve(ROOT, 'netlify/functions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('cron-'))
    .map((d) => d.name)
    .sort();
}

function scheduleDe(nombre: string): string | null {
  const re = new RegExp(`\\[functions\\."${nombre}"\\]\\s*\\n\\s*schedule\\s*=\\s*"([^"]+)"`);
  return toml.match(re)?.[1] ?? null;
}

describe('netlify.toml — crons programados', () => {
  it('no usa el bloque inexistente [[scheduled_functions]]', () => {
    expect(toml).not.toMatch(/\[\[scheduled_functions\]\]/);
  });

  it('hay al menos un cron en disco (si no, el test no prueba nada)', () => {
    expect(cronsEnDisco().length).toBeGreaterThan(0);
  });

  it.each(cronsEnDisco())('%s tiene [functions."…"] schedule con una expresión cron de 5 campos', (nombre) => {
    const schedule = scheduleDe(nombre);
    expect(schedule, `falta [functions."${nombre}"] schedule en netlify.toml`).not.toBeNull();
    expect(schedule!.trim().split(/\s+/)).toHaveLength(5);
  });
});
