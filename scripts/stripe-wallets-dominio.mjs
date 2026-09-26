#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Apple Pay / Google Pay en EKKO: registra el dominio en cada cuenta conectada.
// ----------------------------------------------------------------------------
// POR QUÉ EXISTE (solicitud de cambios del cliente, punto 2): el formulario de
// pago de EKKO es el <PaymentElement> de Stripe y los cobros ya se crean con
// `automatic_payment_methods`, así que Apple Pay y Google Pay NO necesitan código
// nuevo. Lo que falta es que Stripe muestre esos botones, y para eso exige que el
// DOMINIO donde vive el formulario esté registrado y verificado.
//
// Con Connect y cobros directos (nuestro caso) el dominio se registra EN LA CUENTA
// CONECTADA del estudio, no en la plataforma — con la llave de la plataforma y el
// header Stripe-Account. Registrarlo solo en la plataforma no sirve: es el error
// típico, y el síntoma es "Apple Pay simplemente no aparece", sin ningún error.
//
// USO:
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-wallets-dominio.mjs
//   (opcional) --host=otro-dominio.app   --solo-ver
//
// IDEMPOTENTE: si el dominio ya está registrado en una cuenta, lo reporta y sigue.
// Apple Pay solo funciona en LIVE y en HTTPS; en test se puede probar Google Pay.
//
// CÓMO COMPROBARLO DESPUÉS: en un iPhone con una tarjeta en Wallet, abrir
// https://<host> en SAFARI (no dentro de Instagram/WhatsApp), iniciar sesión y
// llegar al pago: arriba del formulario de tarjeta debe salir el botón de Apple Pay.
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';

function morir(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY;
if (!key) morir('Falta STRIPE_SECRET_KEY (la de la PLATAFORMA).');

const args = process.argv.slice(2);
const host = (args.find((a) => a.startsWith('--host=')) ?? '--host=ekkostudio.app').split('=')[1];
const soloVer = args.includes('--solo-ver');

const stripe = new Stripe(key);
const live = key.startsWith('sk_live_');

console.log(`\nDominio: ${host} · modo ${live ? 'LIVE' : 'TEST'}${soloVer ? ' · solo ver' : ''}\n`);
if (!live) console.log('  ⚠ En modo TEST Apple Pay no aparece en dispositivos reales; sirve para validar el registro.\n');

let cuentas = 0;
let pendientes = 0;

// La cuenta Stripe de la plataforma se COMPARTE con SALA/HSC: solo las de EKKO.
for await (const acct of stripe.accounts.list({ limit: 100 })) {
  if (acct.metadata?.app !== 'ekko') continue;
  cuentas++;
  const opt = { stripeAccount: acct.id };
  const nombre = acct.business_profile?.name ?? acct.email ?? acct.id;

  const existentes = await stripe.paymentMethodDomains.list({ domain_name: host, limit: 10 }, opt);
  let dominio = existentes.data.find((d) => d.domain_name === host) ?? null;

  if (!dominio && soloVer) {
    pendientes++;
    console.log(`  ✖ ${nombre} (${acct.id}): dominio SIN registrar`);
    continue;
  }
  if (!dominio) {
    dominio = await stripe.paymentMethodDomains.create({ domain_name: host }, opt);
    console.log(`  ✔ ${nombre} (${acct.id}): dominio registrado`);
  } else if (!dominio.enabled && !soloVer) {
    dominio = await stripe.paymentMethodDomains.update(dominio.id, { enabled: true }, opt);
  }

  // Si quedó inactivo (p. ej. la verificación corrió antes de que el sitio
  // estuviera publicado), pedirle a Stripe que lo valide otra vez.
  if (!soloVer && dominio.apple_pay?.status !== 'active') {
    try {
      dominio = await stripe.paymentMethodDomains.validate(dominio.id, {}, opt);
    } catch (e) {
      console.log(`      ⚠ No se pudo revalidar: ${e instanceof Error ? e.message : e}`);
    }
  }

  const estado = (w) => dominio?.[w]?.status ?? 'desconocido';
  const apple = estado('apple_pay');
  const google = estado('google_pay');
  console.log(`      Apple Pay: ${apple} · Google Pay: ${google} · Link: ${estado('link')}`);
  if (apple !== 'active') {
    pendientes++;
    const detalle = dominio?.apple_pay?.status_details?.error_message;
    console.log(`      ⚠ Apple Pay no está activo${detalle ? `: ${detalle}` : ''}.`);
    console.log('        Confirma que el sitio ya está publicado en ese dominio (HTTPS) y vuelve a correr este script.');
  }
  if (!acct.charges_enabled) {
    console.log('      ⚠ La cuenta aún no puede cobrar (charges_enabled=false): termina el alta en Admin → Cobros.');
  }
}

if (cuentas === 0) {
  morir("No hay cuentas conectadas con metadata.app='ekko'. El estudio debe activar sus cobros primero (Admin → Cobros).");
}
console.log(
  pendientes === 0
    ? `\n✔ Listo: ${cuentas} cuenta(s) con el dominio activo para wallets.\n`
    : `\n⚠ ${pendientes} pendiente(s). Apple Pay no aparecerá hasta que el dominio quede "active".\n`
);
