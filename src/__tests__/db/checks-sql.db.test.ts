// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { levantarBase, type BaseDePrueba } from './harness';

/**
 * Los 9 checks de `supabase/tests/*.sql` (hardening, drift de esquema, privilegios…)
 * se corrían pegándolos a mano en el SQL editor de Supabase. Aquí corren en CI
 * contra la base embebida: cada fila debe ser ✅ PASS (o ⏭ SKIP cuando el caso
 * necesita datos que una base limpia no tiene).
 */

const DIR = resolve(__dirname, '../../../supabase/tests');
const archivos = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

let b: BaseDePrueba;
beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

describe('supabase/tests/*.sql', () => {
  it('hay checks en disco', () => {
    expect(archivos.length).toBeGreaterThan(5);
  });

  it.each(archivos)('%s → todo ✅ PASS o ⏭ SKIP', async (archivo) => {
    const res = await b.db.exec(readFileSync(resolve(DIR, archivo), 'utf8'));
    const filas = res.flatMap((r) => (r.rows ?? []) as Record<string, unknown>[]);
    const resultado = (f: Record<string, unknown>) => String(f.resultado ?? Object.values(f).at(-1) ?? '');
    const malas = filas.filter((f) => !/^(✅|⏭)/.test(resultado(f)));
    expect(malas, JSON.stringify(malas, null, 1)).toEqual([]);
  });
});
