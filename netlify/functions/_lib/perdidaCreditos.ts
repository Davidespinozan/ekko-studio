import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PKG-01F (D-01F-6) · Consentimiento server-side para perder créditos.
 *
 * Pasar de un paquete con saldo a un plan MENSUAL quema ese saldo cuando R1
 * activa el plan nuevo (el webhook llama a `activar_membresia` con
 * `p_confirmar_perdida` por defecto). El webhook no cambia (01A): el
 * consentimiento se exige al CREAR el objeto financiero, que es el único
 * momento en que el miembro puede decidir. Sin consentimiento explícito no
 * existe PaymentIntent ni suscripción que el webhook pueda activar. El
 * consentimiento queda como evidencia en la metadata del objeto de Stripe.
 */

/** Créditos vivos que se perderían: mismo criterio que activar_membresia (M12). */
export async function saldoCreditosVivo(admin: SupabaseClient, usuarioId: string): Promise<number> {
  const { data, error } = await admin
    .from('membresias')
    .select('creditos_restantes, periodo_actual_fin')
    .eq('usuario_id', usuarioId)
    .in('status', ['trialing', 'activa', 'past_due', 'pausada']);
  if (error) throw new Error(`saldo_creditos: ${error.message}`);
  const ahora = Date.now();
  return (data ?? []).reduce((acc, m) => {
    const c = Number(m.creditos_restantes) || 0;
    const fin = m.periodo_actual_fin ? new Date(m.periodo_actual_fin as string).getTime() : null;
    return c > 0 && (fin === null || fin > ahora) ? acc + c : acc;
  }, 0);
}

/** `true` solo con el booleano explícito; nada de strings ni defaults. */
export function consentimientoPerdida(v: unknown): boolean {
  return v === true;
}
