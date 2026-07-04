import { backendPost } from '@shared/lib/backend';

/** Invitados de una reserva (recepción): registrar nombre + foto y cobrar extras. */

export interface Invitado {
  id: string;
  nombre: string;
  es_extra: boolean;
  foto_url: string | null;
  created_at: string;
}

export interface InvitadosResp {
  invitados: Invitado[];
  max_incluidos: number;
  precio_invitado_extra_centavos: number;
  extras: number;
  total: number;
}

export function listarInvitados(reserva_id: string): Promise<InvitadosResp> {
  return backendPost<InvitadosResp>('reception-invitados', { action: 'list', reserva_id });
}

export function agregarInvitado(
  reserva_id: string,
  nombre: string,
  foto?: { base64: string; contentType: string }
): Promise<InvitadosResp> {
  return backendPost<InvitadosResp>('reception-invitados', { action: 'add', reserva_id, nombre, foto });
}

export function quitarInvitado(reserva_id: string, invitado_id: string): Promise<InvitadosResp> {
  return backendPost<InvitadosResp>('reception-invitados', { action: 'remove', reserva_id, invitado_id });
}
