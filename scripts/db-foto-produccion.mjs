#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// FOTO ANÓNIMA DE PRODUCCIÓN (Supabase) · SOLO LECTURA.
//
// Ejecuta SQL de SOLO LECTURA contra la base de producción por la Management API
// de Supabase y produce evidencia comparable entre antes/después de una
// activación: historial de migraciones, inventario del esquema (hash de cada
// función, trigger, política, constraint, índice y columna), conteos y hashes
// por tabla de negocio (sin filas, sin PII) y hashes de funciones concretas.
//
// GUARDAS:
//   · Rechaza cualquier SQL que contenga INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/
//     TRUNCATE/GRANT/REVOKE/COPY/CALL/DO (salvo --permitir-escritura, que NO
//     debe usarse en este script: existe solo para no mentir sobre el límite).
//   · Nunca imprime ni guarda el token. Sin PII: solo md5 de filas y conteos.
//
// TOKEN: variable SUPABASE_ACCESS_TOKEN o, en macOS, el llavero del Supabase CLI
//   (`security find-generic-password -s "Supabase CLI"`), que puede venir con el
//   prefijo `go-keyring-base64:`.
//
// USO:
//   node scripts/db-foto-produccion.mjs foto [--salida archivo.json]
//   node scripts/db-foto-produccion.mjs inventario [--salida archivo.json]
//   node scripts/db-foto-produccion.mjs hashes fn1 fn2 ...      md5 de pg_get_functiondef
//   node scripts/db-foto-produccion.mjs comparar antes.json despues.json
//   node scripts/db-foto-produccion.mjs sql "select ..."          SQL de solo lectura
//   (opcional) PROJECT_REF=otro_ref · por defecto el de EKKO.
// ════════════════════════════════════════════════════════════════════════════

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT_REF = process.env.PROJECT_REF || 'cfihcrjbvgjiohedsjos';
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// Tablas de negocio cuyo contenido debe quedar idéntico tras una migración.
// Para `reservas` se excluyen columnas que una migración puede AGREGAR vacías
// (pásalas con --ignorar-cols tabla:col1,col2 si hace falta otra).
const TABLAS = [
  'usuarios', 'membresias', 'reservas', 'membresia_movimientos', 'payment_events',
  'stripe_webhook_events', 'ventas_mostrador', 'reversales_pago', 'revisiones_financieras',
  'invitados_extra_pagos', 'invitados_extra_traslados', 'reserva_invitados',
  'notificaciones', 'audit_log', 'tiers', 'recursos', 'usuarios_datos_privados', 'tenants',
  'stripe_operaciones_suscripcion'
];

const PROHIBIDO = /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|call|do|vacuum|refresh)\b/i;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  try {
    let t = execSync('security find-generic-password -s "Supabase CLI" -w', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (t.startsWith('go-keyring-base64:')) t = Buffer.from(t.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
    return t;
  } catch {
    console.error('Sin token: define SUPABASE_ACCESS_TOKEN o inicia sesión en el Supabase CLI.');
    process.exit(2);
  }
}

async function sql(query, { permitirEscritura = false } = {}) {
  // Quita literales y comentarios antes de buscar palabras prohibidas.
  const sinLiterales = query.replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, '');
  if (!permitirEscritura && PROHIBIDO.test(sinLiterales)) {
    throw new Error('Rechazado: el SQL contiene una palabra de escritura. Este script es de solo lectura.');
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${texto.slice(0, 300)}`);
  return JSON.parse(texto);
}

const Q = {
  inventario: `select json_build_object(
    'migraciones', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
    'funcs', (select json_object_agg(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'pols', (select json_object_agg(tablename||'.'||policyname, md5(cmd||coalesce(qual,'')||coalesce(with_check,'')||array_to_string(roles,','))) from pg_policies where schemaname='public'),
    'cols', (select json_object_agg(table_name||'.'||column_name, data_type||':'||is_nullable||':'||coalesce(column_default,'')) from information_schema.columns where table_schema='public'),
    'cons', (select json_object_agg(conrelid::regclass::text||'.'||conname, md5(pg_get_constraintdef(oid))) from pg_constraint where connamespace='public'::regnamespace),
    'trgs', (select json_object_agg(tgrelid::regclass::text||'.'||tgname, md5(pg_get_triggerdef(oid))) from pg_trigger where not tgisinternal and tgrelid::regclass::text not like '%.%'),
    'idx', (select json_object_agg(indexname, md5(indexdef)) from pg_indexes where schemaname='public')
  ) r`,
  tabla: (t, ignorar) => {
    const fila = ignorar.length ? `(to_jsonb(x) ${ignorar.map((c) => `- '${c}'`).join(' ')})::text` : 'x::text';
    const orden = t === 'usuarios_datos_privados' ? 'usuario_id' : t === 'stripe_webhook_events' ? '1' : 'id';
    return `select '${t}' tabla, count(*) n, md5(coalesce(string_agg(md5(${fila}), '' order by ${orden}), '')) h from ${t} x`;
  },
  hashes: (fns) => `select p.oid::regprocedure::text f, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any(array[${fns.map((f) => `'${f.replace(/[^a-z0-9_]/gi, '')}'`).join(',')}]) order by 1`
};

function leerIgnorar(args) {
  const m = new Map();
  for (const a of args) {
    if (a.startsWith('--ignorar-cols=')) {
      const [t, cols] = a.slice('--ignorar-cols='.length).split(':');
      m.set(t, (cols ?? '').split(',').filter(Boolean));
    }
  }
  return m;
}

function salida(args, dato) {
  const i = args.indexOf('--salida');
  const json = JSON.stringify(dato, null, 1);
  if (i >= 0 && args[i + 1]) { writeFileSync(args[i + 1], json); console.error(`guardado en ${args[i + 1]}`); }
  else console.log(json);
}

function comparar(a, b) {
  const dif = {};
  for (const k of ['funcs', 'pols', 'cols', 'cons', 'trgs', 'idx']) {
    const A = a.inventario?.[k] ?? {}, B = b.inventario?.[k] ?? {};
    const nuevas = Object.keys(B).filter((x) => !(x in A)).sort();
    const quitadas = Object.keys(A).filter((x) => !(x in B)).sort();
    const cambiadas = Object.keys(A).filter((x) => x in B && A[x] !== B[x]).sort()
      .map((x) => (k === 'funcs' ? `${x} ${A[x].slice(0, 8)}→${B[x].slice(0, 8)}` : x));
    dif[k] = { antes: Object.keys(A).length, despues: Object.keys(B).length, nuevas, quitadas, cambiadas };
  }
  const tablas = {};
  for (const t of Object.keys(a.tablas ?? {})) {
    const x = a.tablas[t], y = b.tablas?.[t];
    tablas[t] = !y ? 'SIN DATO DESPUÉS' : x.n === y.n && x.h === y.h ? 'OK' : `DIFF ${x.n}/${x.h.slice(0, 12)} → ${y.n}/${y.h.slice(0, 12)}`;
  }
  return {
    migraciones: { antes: a.inventario?.migraciones?.length, despues: b.inventario?.migraciones?.length,
      nuevas: (b.inventario?.migraciones ?? []).filter((v) => !(a.inventario?.migraciones ?? []).includes(v)) },
    esquema: dif, tablas
  };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 28).join('\n')); process.exit(cmd ? 0 : 1); }

  if (cmd === 'inventario') {
    const r = await sql(Q.inventario);
    return salida(args, { tomada: new Date().toISOString(), inventario: r[0].r });
  }
  if (cmd === 'foto') {
    const ignorar = leerIgnorar(args);
    const inv = (await sql(Q.inventario))[0].r;
    const tablas = {};
    for (const t of TABLAS) {
      try {
        const r = (await sql(Q.tabla(t, ignorar.get(t) ?? [])))[0];
        tablas[t] = { n: Number(r.n), h: r.h };
      } catch (e) {
        tablas[t] = { n: null, h: null, error: String(e.message).slice(0, 120) }; // la tabla puede no existir aún
      }
    }
    return salida(args, { tomada: new Date().toISOString(), inventario: inv, tablas });
  }
  if (cmd === 'hashes') {
    if (!args.length) throw new Error('Indica al menos una función');
    const r = await sql(Q.hashes(args.filter((a) => !a.startsWith('--'))));
    for (const x of r) console.log(`${x.h.slice(0, 8)}  ${x.f}`);
    return;
  }
  if (cmd === 'comparar') {
    const [a, b] = args.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    return console.log(JSON.stringify(comparar(a, b), null, 1));
  }
  if (cmd === 'sql') {
    const r = await sql(args.join(' '));
    return console.log(JSON.stringify(r, null, 1));
  }
  throw new Error(`Comando desconocido: ${cmd}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
