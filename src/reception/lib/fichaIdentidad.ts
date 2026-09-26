import { backendGet, backendPost } from '@shared/lib/backend';

/**
 * Ficha de identidad del miembro (expediente). Recepción la captura en la
 * primera sesión; sin ella + contrato firmado, el check-in queda bloqueado.
 */

export interface FichaIdentidad {
  fecha_nacimiento: string | null;
  domicilio: string | null;
  ine_folio: string | null;
  ine_foto_url: string | null;
  tiene_foto: boolean;
  identidad_completa: boolean;
  contrato_firmado: boolean;
}

export function getFichaIdentidad(usuario_id: string): Promise<FichaIdentidad> {
  return backendGet<FichaIdentidad>('reception-datos-identidad', { usuario_id });
}

/**
 * PATCH: solo los campos presentes se tocan; un campo ausente conserva su valor
 * en el servidor. `null` es un borrado explícito (la UI no lo manda).
 */
export interface GuardarFichaInput {
  usuario_id: string;
  fecha_nacimiento?: string | null;
  domicilio?: string | null;
  ine_folio?: string | null;
  ine_foto?: { base64: string; contentType: string };
  /** Solo true (firma). Quitar una firma no se hace por aquí. */
  contrato_firmado?: boolean;
}

export function guardarFichaIdentidad(
  input: GuardarFichaInput
): Promise<{ success: boolean; identidad_completa: boolean; contrato_firmado: boolean; cambios?: string[]; aviso?: string }> {
  return backendPost('reception-datos-identidad', input);
}
