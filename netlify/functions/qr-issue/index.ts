import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /qr-issue
 * Body: { reserva_id: string }
 * Auth: Bearer JWT del miembro dueño de la reserva
 *
 * Devuelve un JWT firmado server-side que contiene { reserva_id, tenant_id, exp }
 * Expira 30 min después del slot_fin de la reserva.
 */

interface IssueRequest {
  reserva_id: string;
}

interface IssueResponse {
  qr_payload: string; // string a codificar en el QR
  expires_at: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return badRequest('Method not allowed');
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return unauthorized('Missing bearer token');
    }
    const userToken = authHeader.slice('Bearer '.length);

    const body: IssueRequest = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id required');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const jwtSecret = requireEnv('QR_JWT_SECRET');

    // Cliente con token del usuario (respeta RLS)
    const supabase = createClient(supabaseUrl, anonKey, {      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    // Identificar al usuario actual (auth.users.id) para validar ownership.
    const { data: authData, error: authErr } = await supabase.auth.getUser(userToken);
    if (authErr || !authData?.user) {
      return unauthorized('Token inválido');
    }
    const authUserId = authData.user.id;

    // Mapear auth_id → usuarios.id + tenant_id (necesario para validar
    // ownership y tenant; RLS también lo limita, pero somos defensivos).
    const { data: usuarioRow, error: usuarioErr } = await supabase
      .from('usuarios')
      .select('id, tenant_id')
      .eq('auth_id', authUserId)
      .maybeSingle();
    if (usuarioErr || !usuarioRow) {
      return unauthorized('Usuario no encontrado');
    }

    // Buscar reserva (RLS valida que sea suya; chequeamos explícito igual).
    const { data: reserva, error } = await supabase
      .from('reservas')
      .select('id, tenant_id, usuario_id, slot_inicio, slot_fin, status')
      .eq('id', body.reserva_id)
      .maybeSingle();

    if (error || !reserva) {
      return unauthorized('Reserva no encontrada o no autorizada');
    }

    // Defensa profundidad: ownership + tenant.
    if (reserva.usuario_id !== usuarioRow.id) {
      return unauthorized('Reserva de otro usuario');
    }
    if (reserva.tenant_id !== usuarioRow.tenant_id) {
      return unauthorized('Reserva de otro tenant');
    }

    // Whitelist: solo se emite QR para reservas confirmadas.
    // Cualquier otro status devuelve mensaje específico para que el
    // frontend lo traduzca a copy human-friendly.
    const STATUS_QR_VALIDO = 'confirmada';
    if (reserva.status !== STATUS_QR_VALIDO) {
      const motivos: Record<string, string> = {
        cancelada: 'La reserva fue cancelada',
        cancelada_admin: 'La reserva fue cancelada por administración',
        completada: 'Ya hiciste check-in para esta reserva',
        no_show: 'La reserva expiró sin check-in'
      };
      const msg = motivos[reserva.status] ?? `Status no válido para QR: ${reserva.status}`;
      return badRequest(msg);
    }

    // Ventana temporal: ±7 días alrededor del slot_inicio. Reservas muy
    // viejas o muy lejanas no pueden emitir QR (defensa contra abuso).
    const slotInicio = new Date(reserva.slot_inicio);
    const ahora = new Date();
    const diffDias = Math.abs(slotInicio.getTime() - ahora.getTime()) / 86400000;
    if (diffDias > 7) {
      return badRequest('Reserva fuera de ventana de QR (más de 7 días)');
    }

    // Calcular expiración: slot_fin + 30 min
    const slotFin = new Date(reserva.slot_fin);
    const expiresAt = new Date(slotFin.getTime() + 30 * 60 * 1000);

    // Firmar JWT manualmente (HMAC-SHA256)
    const payload = {
      reserva_id: reserva.id,
      tenant_id: reserva.tenant_id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000)
    };

    const jwt = await signJWT(payload, jwtSecret);

    return ok<IssueResponse>({
      qr_payload: jwt,
      expires_at: expiresAt.toISOString()
    });
  } catch (e) {
    console.error('[qr-issue]', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

/**
 * JWT HS256 manual (sin dependencia externa para mantener el bundle chico).
 */
async function signJWT(payload: object, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSHA256(data, secret);
  return `${data}.${signature}`;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hmacSHA256(data: string, secret: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
