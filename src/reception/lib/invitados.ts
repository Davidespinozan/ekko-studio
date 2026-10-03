import { backendPost } from '@shared/lib/backend';

/**
 * Invitados de una reserva (recepción): registrar nombre + foto de los invitados
 * que la reserva cubre. PKG-01H: el servidor manda (tope, ventana, es_extra); en
 * recepción no se cobra nada.
 */

export interface Invitado {
  id: string;
  nombre: string;
  es_extra: boolean;
  foto_url: string | null;
  created_at: string;
}

export interface InvitadosResp {
  invitados: Invitado[];
  /** Incluidos al reservar (snapshot de la reserva, no el plan actual del miembro). */
  max_incluidos: number;
  /** Extras que el miembro ya pagó en la app (Stripe). Amplían la cobertura. */
  invitados_extra_pagados: number;
  precio_invitado_extra_centavos: number;
  extras: number;
  /** incluidos + extras pagados: máximo de fichas que acepta el servidor. */
  cubiertos: number;
  /** Lugares que aún se pueden registrar. */
  disponibles: number;
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
