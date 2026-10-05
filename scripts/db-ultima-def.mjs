#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// ÚLTIMA definición efectiva de una función SQL en supabase/migrations.
// SOLO LECTURA sobre archivos locales. No toca la base.
//
// Por qué: 26 de las ~100 funciones están redefinidas en más de una migración
// (reservar_recurso_atomic en 11). Recrear una función partiendo de una
// definición vieja ya reintrodujo bugs. Regla: partir SIEMPRE de la última.
//
// USO:
//   node scripts/db-ultima-def.mjs <nombre_funcion>          imprime la definición
//   node scripts/db-ultima-def.mjs <nombre_funcion> --donde  solo archivo:línea
//   node scripts/db-ultima-def.mjs --historial <nombre>      todas las migraciones que la definen
//   node scripts/db-ultima-def.mjs --redefinidas             funciones definidas en >1 archivo
// ════════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const archivos = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

/** Devuelve [{archivo, linea, cuerpo}] de cada CREATE OR REPLACE FUNCTION <nombre>( en orden de migración. */
function definiciones(nombre) {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${nombre}\\s*\\(`, 'gi');
  const out = [];
  for (const f of archivos) {
    const src = readFileSync(resolve(DIR, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const fin = src.indexOf('$$;', m.index);
      const cuerpo = fin === -1 ? src.slice(m.index) : src.slice(m.index, fin + 3);
      out.push({ archivo: f, linea: src.slice(0, m.index).split('\n').length, cuerpo });
    }
  }
  return out;
}

function todas() {
  const mapa = new Map();
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi;
  for (const f of archivos) {
    const src = readFileSync(resolve(DIR, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const n = m[1].toLowerCase();
      if (!mapa.has(n)) mapa.set(n, new Set());
      mapa.get(n).add(f);
    }
  }
  return mapa;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
  process.exit(args.length === 0 ? 1 : 0);
}

if (args[0] === '--redefinidas') {
  const filas = [...todas()].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size);
  for (const [n, s] of filas) console.log(`${String(s.size).padStart(2)}  ${n}  (última: ${[...s].sort().at(-1)})`);
  process.exit(0);
}

if (args[0] === '--historial') {
  const defs = definiciones(args[1] ?? '');
  if (!defs.length) { console.error(`No hay definiciones de "${args[1]}"`); process.exit(2); }
  for (const d of defs) console.log(`${d.archivo}:${d.linea}`);
  process.exit(0);
}

const nombre = args[0];
const defs = definiciones(nombre);
if (!defs.length) { console.error(`No hay definiciones de "${nombre}" en ${DIR}`); process.exit(2); }
const ultima = defs.at(-1);
if (args.includes('--donde')) {
  console.log(`${ultima.archivo}:${ultima.linea}`);
} else {
  console.log(`-- última definición: ${ultima.archivo}:${ultima.linea} (${defs.length} definición(es) en total)`);
  console.log(ultima.cuerpo);
}
