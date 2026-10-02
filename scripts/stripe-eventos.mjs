// Eventos que el endpoint de Connect debe recibir. ÚNICA lista: la importan
// stripe-setup-webhooks.mjs (que SINCRONIZA el endpoint con ella: lo que no esté
// aquí, lo quita) y stripe-check.mjs.
//
// Debe coincidir con los `case '…'` de clasificarEvento en
// netlify/functions/_lib/stripe.ts — lo exige src/__tests__/stripe-eventos.test.ts.
// Antes eran dos copias a mano y `charge.refunded` tenía handler pero no estaba
// suscrito: los reembolsos nunca llegaban al webhook.
export const EVENTOS_WEBHOOK = [
  'account.application.deauthorized',
  'account.updated',
  'charge.dispute.closed',
  'charge.dispute.created',
  'charge.dispute.funds_reinstated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.updated',
  'charge.refunded',
  'checkout.session.completed',
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'payment_intent.succeeded',
  'refund.created',
  'refund.failed',
  'refund.updated'
];
