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

/**
 * /reception-invitados — invitados de una reserva (ficha por invitado + extras).
 * Auth: Bearer JWT de admin / recepcionista / staff. Todo pasa por aquí porque
 * la tabla es service_role-only y las fotos van en el bucket privado 'identidad'.
 *
 *   POST { action: 'list',   reserva_id }
 *   POST { action: 'add',    reserva_id, nombre, foto?: { base64, contentType } }
 *   POST { action: 'remove', reserva_id, invitado_id }
 *
 * es_extra se calcula al agregar: si ya hay >= max_invitados del plan, el nuevo
 * va "arriba del tope" (cobrado en recepción). El precio por extra sale de
 * config.reserva.precio_invitado_extra_centavos.
 */

interface Body {
  action?: 'list' | 'add' | 'remove';
  reserva_id?: string;
  invitado_id?: string;
  nombre?: string;
  foto?: { base64?: string; contentType?: string };
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

const ROLES_OK = ['admin', 'recepcionista', 'staff'];

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
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!caller || !ROLES_OK.includes(caller.rol)) {
      return forbidden('Solo recepción, staff o admin pueden hacer esto');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id requerido');

    // Reserva del MISMO tenant (H3).
    const { data: reserva } = await admin
      .from('reservas')
      .select('id, tenant_id, usuario_id')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) return forbidden('Esa reserva es de otro estudio');

    // Precio por invitado extra (config del tenant) + tope del plan del miembro.
    const { data: tenant } = await admin.from('tenants').select('config').eq('id', caller.tenant_id).maybeSingle();
    const cfgReserva = ((tenant?.config as Record<string, unknown> | null)?.reserva ?? {}) as Record<string, unknown>;
    const precioExtra = Number(cfgReserva.precio_invitado_extra_centavos) || 0;

    const { data: miembro } = await admin
      .from('usuarios')
      .select('membresia_tier')
      .eq('id', reserva.usuario_id)
      .maybeSingle();
    let maxIncluidos = 0;
    if (miembro?.membresia_tier) {
      const { data: tier } = await admin
        .from('tiers')
        .select('reglas')
        .eq('tenant_id', caller.tenant_id)
        .eq('slug', miembro.membresia_tier)
        .maybeSingle();
      maxIncluidos = Number((tier?.reglas as Record<string, unknown> | null)?.max_invitados) || 0;
    }

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
      const extras = invitados.filter((i) => i.es_extra).length;
      return ok({
        invitados,
        max_incluidos: maxIncluidos,
        precio_invitado_extra_centavos: precioExtra,
        extras,
        total: invitados.length
      });
    }

    if (!body.action || body.action === 'list') {
      return await listar();
    }

    if (body.action === 'add') {
      const nombre = body.nombre?.trim();
      if (!nombre) return badRequest('El nombre del invitado es requerido');

      // ¿Este invitado va arriba del tope del plan? (los ya registrados + este)
      const { count } = await admin
        .from('reserva_invitados')
        .select('id', { count: 'exact', head: true })
        .eq('reserva_id', body.reserva_id);
      const yaRegistrados = count ?? 0;
      const esExtra = yaRegistrados >= maxIncluidos;

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

      const { data: inserted, error: insErr } = await admin
        .from('reserva_invitados')
        .insert({
          tenant_id: caller.tenant_id,
          reserva_id: body.reserva_id,
          nombre,
          foto_path: fotoPath,
          es_extra: esExtra,
          created_by: caller.id
        })
        .select('id')
        .single();
      if (insErr) return serverError(insErr.message);

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
