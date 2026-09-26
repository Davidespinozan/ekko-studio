#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO de la config de Stripe para EKKO. SOLO LECTURA: no crea, no
// modifica y no borra nada. Contesta "¿qué falta?" sin adivinar.
//
// Chequea, contra lo que el código realmente necesita:
//   1. El webhook de Connect (URL sin redirección, eventos, Connected accounts).
//   2. Las cuentas conectadas creadas por EKKO (metadata.app='ekko'): si ya
//      pueden cobrar (charges_enabled) y quién paga las fees (controller).
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-check.mjs
//   (opcional) HOST=otro-dominio.app
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { EVENTOS_WEBHOOK } from './stripe-eventos.mjs';

// La cuenta de Stripe está COMPARTIDA con SALA/HSC: se filtra por host y por
// metadata.app para no reportar falsos errores sobre endpoints ajenos.
const HOST = process.env.HOST || 'ekkostudio.app';
const URL_WEBHOOK = `https://${HOST}/.netlify/functions/stripe-webhook`;

// = case '...' de netlify/functions/_lib/stripe.ts → clasificarEvento
const EVENTOS = EVENTOS_WEBHOOK;

const ok = (s) => `  ✔ ${s}`;
const falta = (s) => `  ✖ ${s}`;
const aviso = (s) => `  ⚠ ${s}`;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('\n✖ Falta STRIPE_SECRET_KEY.\n  Uso: STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-check.mjs\n');
    process.exit(1);
  }
  const stripe = new Stripe(key);
  const modo = key.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`\n════ Diagnóstico Stripe · EKKO · modo ${modo} ════\n`);
  let problemas = 0;

  // ── 1) Webhook ────────────────────────────────────────────────────────────
  console.log('1. WEBHOOK DE CONNECT');
  try {
    const r = await fetch(URL_WEBHOOK, { method: 'POST', redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      console.log(falta(`${URL_WEBHOOK} responde ${r.status}: redirección → Stripe perdería todos los eventos`));
      problemas++;
    } else if (r.status === 404) {
      console.log(falta(`${URL_WEBHOOK} responde 404: función no deployada`));
      problemas++;
    } else {
      console.log(ok(`${URL_WEBHOOK} responde ${r.status} (directo)`));
    }
  } catch (e) {
    console.log(falta(`No pude alcanzar ${URL_WEBHOOK}: ${e?.message ?? e}`));
    problemas++;
  }

  const endpoints = [];
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) endpoints.push(ep);
  const ep = endpoints.find((e) => e.url === URL_WEBHOOK);
  if (!ep) {
    console.log(falta(`No hay endpoint registrado con URL ${URL_WEBHOOK} → node scripts/stripe-setup-webhooks.mjs`));
    problemas++;
  } else {
    console.log(ok(`Endpoint ${ep.id} (${ep.status})`));
    if (ep.status !== 'enabled') {
      console.log(falta('El endpoint está deshabilitado'));
      problemas++;
    }
    const habilitados = ep.enabled_events ?? [];
    const faltan = EVENTOS.filter((ev) => !habilitados.includes(ev) && !habilitados.includes('*'));
    if (faltan.length) {
      console.log(falta(`Faltan eventos: ${faltan.join(', ')}`));
      problemas++;
    } else {
      console.log(ok(`Escucha los ${EVENTOS.length} eventos que maneja el código`));
    }
    // La API no expone el flag connect al listar: si lo creó el script lleva metadata.app.
    if (ep.metadata?.app === 'ekko') console.log(ok('Creado por scripts/stripe-setup-webhooks.mjs (Connected accounts)'));
    else console.log(aviso('Creado a mano: confirma en el dashboard que escucha "Connected accounts" (no "Your account")'));
  }

  // ── 2) Cuentas conectadas de EKKO ─────────────────────────────────────────
  console.log('\n2. CUENTAS CONECTADAS (estudios)');
  let n = 0;
  for await (const acct of stripe.accounts.list({ limit: 100 })) {
    if (acct.metadata?.app !== 'ekko') continue;
    n++;
    const fees = acct.controller?.fees?.payer ?? acct.type;
    const linea = `${acct.id} · tenant ${acct.metadata?.tenant_id ?? '?'} · ${acct.country} · charges_enabled=${acct.charges_enabled} · payouts_enabled=${acct.payouts_enabled} · fees.payer=${fees}`;
    if (!acct.charges_enabled) {
      console.log(aviso(linea + ' → onboarding incompleto'));
    } else {
      console.log(ok(linea));
    }
    if (fees === 'application_express' || fees === 'application') {
      console.log(aviso('   La plataforma paga los Connect fees ($2/mes activa + payout fees) de esta cuenta. Ver SALA_PARITY_AUDIT.md §1.'));
    }
  }
  if (n === 0) console.log(aviso('Ninguna cuenta conectada con metadata.app=ekko (¿aún no se activaron cobros?)'));

  console.log(problemas ? `\n✖ ${problemas} problema(s).\n` : '\n✔ Todo en orden.\n');
  process.exit(problemas ? 1 : 0);
}

main().catch((e) => {
  console.error('\n✖ Falló:', e?.message ?? e, '\n');
  process.exit(1);
});
