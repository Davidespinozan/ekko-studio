#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Crea (o sincroniza) el webhook de Stripe Connect que usa EKKO.
// ----------------------------------------------------------------------------
// POR QUÉ EXISTE: crear el webhook a mano en el dashboard es propenso a errores
// (URL con `www.` que redirige, faltó un evento, o no marcar "Connected
// accounts" → los pagos no activan membresías y nadie se entera). Este script
// lo crea con la URL, los eventos y el flag connect exactos que espera el
// backend. Lección de SALA (3fddde9 / a3ca993).
//
// LOS EVENTOS NO SE HARDCODEAN A CIEGAS: son los mismos `case '...'` de
// netlify/functions/_lib/stripe.ts (clasificarEvento). Si agregas un case nuevo,
// agrégalo aquí.
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-webhooks.mjs
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup-webhooks.mjs --live
//   (opcional) --host=otro-dominio.app
//
// IDEMPOTENTE: si ya existe un endpoint con esa URL, NO crea otro (sincroniza
// los eventos). Stripe solo devuelve el signing secret (whsec_) al CREARLO.
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// EKKO es single-tenant y la cuenta de Stripe se COMPARTE con SALA/HSC: el
// endpoint se identifica por URL y lleva metadata.app='ekko'.
function definirWebhooks(host) {
  return [
    {
      nombre: 'Connect (pagos de los miembros a los estudios)',
      path: '/.netlify/functions/stripe-webhook',
      connect: true,
      envVar: 'STRIPE_CONNECT_WEBHOOK_SECRET',
      // = case '...' de _lib/stripe.ts → clasificarEvento
      events: [
        'account.updated',
        'checkout.session.completed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
        'payment_intent.succeeded'
      ]
    }
  ].map((w) => ({ ...w, url: `https://${host}${w.path}` }));
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    morir('Falta STRIPE_SECRET_KEY.\n  Uso: STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-setup-webhooks.mjs');
  }

  const esLive = key.startsWith('sk_live_');
  if (esLive && !process.argv.includes('--live')) {
    morir('Esa es una clave LIVE (dinero real) y no pasaste --live.\n  Si es a propósito:  ... node scripts/stripe-setup-webhooks.mjs --live');
  }

  const hostArg = process.argv.find((a) => a.startsWith('--host='));
  // SIN www: en EKKO el apex (ekkostudio.app) es el primario y www. redirige 308.
  // Stripe NO sigue redirecciones: un endpoint con www aceptaría la creación y
  // después perdería TODOS los eventos en silencio. La verificación de abajo es
  // la red de seguridad.
  const host = hostArg ? hostArg.slice('--host='.length) : 'ekkostudio.app';

  const stripe = new Stripe(key);
  const webhooks = definirWebhooks(host);
  console.log(`\n▸ Modo: ${esLive ? 'LIVE (dinero real)' : 'TEST'}`);
  console.log(`▸ Host: ${host}\n`);

  const existentes = [];
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) existentes.push(ep);

  // ── Red de seguridad: la URL tiene que responder DIRECTO, sin redirección.
  for (const w of webhooks) {
    let estado;
    try {
      const r = await fetch(w.url, { method: 'POST', redirect: 'manual' });
      estado = r.status;
    } catch (e) {
      morir(`No pude alcanzar ${w.url}\n  ${e?.message ?? e}`);
    }
    if (estado >= 300 && estado < 400) {
      morir(
        `${w.url} responde ${estado} (REDIRECCIÓN).\n` +
        '  Stripe no sigue redirecciones: los eventos se perderían en silencio.\n' +
        '  Usa el host definitivo (prueba con/sin "www"):  --host=tu-dominio.app'
      );
    }
    if (estado === 404) {
      morir(`${w.url} responde 404: esa función no existe o no está deployada.`);
    }
    console.log(`  ✓ ${w.url} responde ${estado} (sin redirección; 400 = función viva esperando firma)`);
  }
  console.log('');

  const secretos = [];
  for (const w of webhooks) {
    const previo = existentes.find((e) => e.url === w.url);
    if (previo) {
      const previos = previo.enabled_events ?? [];
      const faltan = w.events.filter((ev) => !previos.includes(ev) && !previos.includes('*'));
      const sobran = previos.includes('*') ? [] : previos.filter((ev) => !w.events.includes(ev));
      if (faltan.length || sobran.length) {
        await stripe.webhookEndpoints.update(previo.id, { enabled_events: w.events });
        console.log(`  ~ ${w.nombre}\n    ${w.url}\n    Actualizado (${previo.id}) — eventos sincronizados${faltan.length ? '  +[' + faltan.join(', ') + ']' : ''}${sobran.length ? '  -[' + sobran.join(', ') + ']' : ''}`);
      } else {
        console.log(`  = ${w.nombre}\n    ${w.url}\n    Ya existe y sus eventos ya están al día (${previo.id}).`);
      }
      if (w.connect && !previo.metadata?.app) {
        console.log('    ⚠ Revisa en el dashboard que escuche "Connected accounts" (no se puede cambiar por API).');
      }
      secretos.push({ envVar: w.envVar, secret: null, yaExistia: true });
      continue;
    }

    const ep = await stripe.webhookEndpoints.create({
      url: w.url,
      enabled_events: w.events,
      connect: w.connect,
      description: `EKKO — ${w.nombre}`,
      metadata: { app: 'ekko' }
    });
    console.log(`  + ${w.nombre}\n    ${w.url}\n    Creado (${ep.id})  ${w.connect ? '[Connected accounts]' : '[Tu cuenta]'}  ${w.events.length} eventos`);
    secretos.push({ envVar: w.envVar, secret: ep.secret, yaExistia: false });
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(' VARIABLES PARA NETLIFY (Site settings → Environment variables)');
  console.log('──────────────────────────────────────────────────────────');
  for (const s of secretos) {
    if (s.secret) console.log(`  ${s.envVar} = ${s.secret}`);
    else console.log(`  ${s.envVar} = (ya existía — dashboard → webhook → "Signing secret" → Reveal, o bórralo y vuelve a correr esto)`);
  }
  console.log('──────────────────────────────────────────────────────────');
  console.log(esLive ? ' Estos whsec_ son de LIVE. Ponlos en Netlify y recién ahí redeploya.\n' : ' Esto fue en TEST. Para live: repite con la clave live y --live.\n');
}

main().catch((e) => {
  console.error('\n✖ Falló:', e?.message ?? e, '\n');
  process.exit(1);
});
