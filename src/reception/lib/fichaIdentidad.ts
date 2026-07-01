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

export interface GuardarFichaInput {
  usuario_id: string;
  fecha_nacimiento?: string | null;
  domicilio?: string | null;
  ine_folio?: string | null;
  ine_foto?: { base64: string; contentType: string };
  contrato_firmado?: boolean;
}

export function guardarFichaIdentidad(
  input: GuardarFichaInput
): Promise<{ success: boolean; identidad_completa: boolean; contrato_firmado: boolean }> {
  return backendPost('reception-datos-identidad', input);
}
