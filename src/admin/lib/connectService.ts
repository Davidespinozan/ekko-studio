import { backendPost } from '@shared/lib/backend';

/**
 * Stripe Connect (Flujo del estudio): activar cobros y consultar el estado de la
 * cuenta conectada. STRYV es la plataforma; el estudio cobra directo.
 */

export interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  details_submitted: boolean;
  payouts_enabled: boolean;
  reason?: string;
  /** PKG-01G: el estudio desautorizó la plataforma en Stripe; hay que reconectar. */
  desconectada?: boolean;
  desconectada_at?: string | null;
  // Enriquecidos (solo cuando connected):
  account_id?: string | null;
  business_name?: string | null;
  email?: string | null;
  pais?: string | null;
  payout_interval?: string | null; // daily | weekly | monthly | manual
  bank?: { bank_name: string | null; last4: string | null } | null;
  balance?: { disponible_centavos: number; pendiente_centavos: number; moneda: string } | null;
  dashboard_url?: string | null;
}

export async function iniciarOnboardingConnect(): Promise<{ url: string | null; reason?: string }> {
  return backendPost('connect-onboarding', { return_path: '/admin/cobros' });
}

export async function obtenerEstadoConnect(): Promise<ConnectStatus> {
  return backendPost('connect-status', {});
}
