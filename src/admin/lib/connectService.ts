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
}

export async function iniciarOnboardingConnect(): Promise<{ url: string | null; reason?: string }> {
  return backendPost('connect-onboarding', { return_path: '/admin/cobros' });
}

export async function obtenerEstadoConnect(): Promise<ConnectStatus> {
  return backendPost('connect-status', {});
}
