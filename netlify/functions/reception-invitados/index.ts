import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { esStaffActivo } from '../_lib/staff';

/**
 * /reception-invitados — invitados de una reserva (ficha por invitado + extras).
 * Auth: Bearer JWT de admin / recepcionista / staff. Todo pasa por aquí porque
 * la tabla es service_role-only y las fotos van en el bucket privado 'identidad'.
 *
 *   POST { action: 'list',   reserva_id }
 *   POST { action: 'add',    reserva_id, nombre, foto?: { base64, contentType } }
 *   POST { action: 'remove', reserva_id, invitado_id }
 *
 * PKG-01H (W-3=A): la RESERVA es la fuente de verdad. Cubiertos =
 * invitados_count (incluidos al reservar) + invitados_extra_pagados (extras que
 * el miembro pagó en la app). El alta pasa por la RPC `registrar_ficha_invitado`,
 * que bloquea la reserva, rechaza fichas por encima de lo cubierto o fuera de la
 * ventana de asistencia, y decide es_extra con el snapshot de la reserva (no con
 * el plan cacheado del miembro). En recepción no se cobra nada.
 */

interface Body {
  action?: 'list' | 'add' | 'remove';
  reserva_id?: string;
  invitado_id?: string;
  nombre?: string;
  foto?: { base64?: string; contentType?: string };
}

const conflicto = (code: string, error: string) => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error, code })
});

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: caller } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id requerido');

    // Reserva del MISMO tenant (H3).
    const { data: reserva } = await admin
      .from('reservas')
      .select('id, tenant_id, usuario_id, invitados_count, invitados_extra_pagados')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) return forbidden('Esa reserva es de otro estudio');

    // Snapshot de la reserva (PKG-01H): incluidos al reservar + extras pagados.
    const incluidos = Number(reserva.invitados_count) || 0;
    const prepagados = Number(reserva.invitados_extra_pagados) || 0;
    const { data: tenant } = await admin.from('tenants').select('config').eq('id', caller.tenant_id).maybeSingle();
    const cfgReserva = ((tenant?.config as Record<string, unknown> | null)?.reserva ?? {}) as Record<string, unknown>;
    const precioExtra = Number(cfgReserva.precio_invitado_extra_centavos) || 0;

    async function listar() {
      const { data: rows } = await admin
        .from('reserva_invitados')
        .select('id, nombre, foto_path, es_extra, created_at')
        .eq('reserva_id', body.reserva_id)
        .order('created_at', { ascending: true });
      const invitados = await Promise.all(
        (rows ?? []).map(async (r) => {
          let foto_url: string | null = null;
          if (r.foto_path) {
            const { data: signed } = await admin.storage.from('identidad').createSignedUrl(r.foto_path, 300);
            foto_url = signed?.signedUrl ?? null;
          }
          return { id: r.id, nombre: r.nombre, es_extra: r.es_extra, foto_url, created_at: r.created_at };
        })
      );
      const total = invitados.length;
      const cubiertos = incluidos + prepagados;
      return ok({
        invitados,
        max_incluidos: incluidos,
        invitados_extra_pagados: prepagados,
        precio_invitado_extra_centavos: precioExtra,
        extras: Math.max(0, total - incluidos),
        cubiertos,
        disponibles: Math.max(0, cubiertos - total),
        total
      });
    }

    if (!body.action || body.action === 'list') {
      return await listar();
    }

    if (body.action === 'add') {
      const nombre = body.nombre?.trim();
      if (!nombre) return badRequest('El nombre del invitado es requerido');

      let fotoPath: string | null = null;
      if (body.foto?.base64 && body.foto.contentType) {
        const buffer = Buffer.from(body.foto.base64, 'base64');
        if (buffer.length > 4 * 1024 * 1024) return badRequest('La foto es muy grande (máx 4MB)');
        const ext = extFromContentType(body.foto.contentType);
        const path = `invitados/${caller.tenant_id}/${body.reserva_id}/${randomUUID()}.${ext}`;
        const { error: upErr } = await admin.storage
          .from('identidad')
          .upload(path, buffer, { contentType: body.foto.contentType, upsert: true });
        if (upErr) return serverError(`No se pudo subir la foto: ${upErr.message}`);
        fotoPath = path;
      }

      // El servidor decide (lock de la reserva, tope, ventana, es_extra).
      const { data: alta, error: altaErr } = await admin.rpc('registrar_ficha_invitado', {
        p_actor_id: caller.id,
        p_reserva_id: body.reserva_id,
        p_nombre: nombre,
        p_foto_path: fotoPath
      });
      if (altaErr) {
        if (fotoPath) await admin.storage.from('identidad').remove([fotoPath]);
        const m = altaErr.message ?? '';
        if (m.includes('EKKO_INVITADOS_NO_CUBIERTOS')) return conflicto('invitados_no_cubiertos', 'La reserva ya tiene registrados todos los invitados que cubre (incluidos + extras pagados).');
        if (m.includes('EKKO_RESERVA_NO_VIGENTE')) return conflicto('reserva_no_vigente', 'La reserva no está vigente: no se registran invitados.');
        if (m.includes('EKKO_RESERVA_PASADA')) return conflicto('reserva_pasada', 'La sesión ya terminó: no se registran invitados.');
        if (m.includes('EKKO_TENANT_DIFERENTE')) return forbidden('Esa reserva es de otro estudio');
        if (m.includes('EKKO_NO_AUTORIZADO')) return forbidden('Solo recepción o admin pueden hacer esto');
        if (m.includes('EKKO_INVITADO_NOMBRE')) return badRequest('El nombre del invitado es requerido');
        return serverError('No se pudo registrar al invitado');
      }
      const inserted = { id: (alta as { invitado_id: string }).invitado_id };
      const esExtra = (alta as { es_extra: boolean }).es_extra;

      await writeAuditLog(admin, {
        tenant_id: caller.tenant_id,
        actor_usuario_id: caller.id,
        actor_rol: caller.rol,
        accion: 'invitado_agregado',
        target_tipo: 'reserva',
        target_id: body.reserva_id,
        despues: { invitado_id: inserted.id, es_extra: esExtra },
        metadata: { con_foto: !!fotoPath }
      });

      return await listar();
    }

    if (body.action === 'remove') {
      if (!body.invitado_id) return badRequest('invitado_id requerido');
      const { data: inv } = await admin
        .from('reserva_invitados')
        .select('id, tenant_id, foto_path')
        .eq('id', body.invitado_id)
        .eq('reserva_id', body.reserva_id)
        .maybeSingle();
      if (!inv || inv.tenant_id !== caller.tenant_id) return notFound('Invitado no encontrado');

      if (inv.foto_path) {
        await admin.storage.from('identidad').remove([inv.foto_path]);
      }
      const { error: delErr } = await admin.from('reserva_invitados').delete().eq('id', body.invitado_id);
      if (delErr) return serverError(delErr.message);

      await writeAuditLog(admin, {
        tenant_id: caller.tenant_id,
        actor_usuario_id: caller.id,
        actor_rol: caller.rol,
        accion: 'invitado_eliminado',
        target_tipo: 'reserva',
        target_id: body.reserva_id,
        metadata: { invitado_id: body.invitado_id }
      });

      return await listar();
    }

    return badRequest('Acción inválida');
  } catch (e) {
    console.error('[reception-invitados]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
