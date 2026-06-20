import { backendPost } from '@shared/lib/backend';

/**
 * Bloque F: marca/desmarca un estudio como "fuera de servicio" (temporal).
 * Al marcarlo fuera de servicio, el backend auto-cancela las reservas futuras
 * de ese estudio y notifica a los miembros. Lo usan recepción y admin.
 */

export interface RecursoServicioResult {
  success: boolean;
  reservas_canceladas: number;
}

export function setRecursoServicio(
  recurso_id: string,
  fuera_de_servicio: boolean,
  motivo?: string
): Promise<RecursoServicioResult> {
  return backendPost<RecursoServicioResult>('reception-recurso-servicio', {
    recurso_id,
    fuera_de_servicio,
    motivo
  });
}
