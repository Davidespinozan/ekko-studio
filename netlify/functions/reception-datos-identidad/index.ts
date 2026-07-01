import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';

/**
 * /reception-datos-identidad — ficha de identidad del miembro (expediente).
 * Auth: Bearer JWT de admin o recepcionista.
 *
 *   GET  ?usuario_id=...  → lee la ficha (con signed URL de la foto de INE).
 *   POST { usuario_id, fecha_nacimiento?, domicilio?, ine_folio?,
 *          ine_foto?: { base64, contentType }, contrato_firmado? }
 *        → guarda (datos sensibles en usuarios_datos_privados vía service_role) y
 *          recalcula usuarios.identidad_completa (gate de check-in).
 *
 * `identidad_completa` = foto (avatar) + fecha_nacimiento + domicilio + INE.
 * El check-in queda bloqueado por trigger hasta que sea true + contrato firmado.
 */

interface Body {
  usuario_id?: string;
  fecha_nacimiento?: string | null;
  domicilio?: string | null;
  ine_folio?: string | null;
  ine_foto?: { base64?: string; contentType?: string };
  contrato_firmado?: boolean;
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

export const handler: Handler = async (event) => {
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
    if (!caller || !['admin', 'recepcionista'].includes(caller.rol)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Target (mismo tenant, H3).
    const usuarioId =
      event.httpMethod === 'GET'
        ? event.queryStringParameters?.usuario_id
        : (JSON.parse(event.body || '{}') as Body).usuario_id;
    if (!usuarioId) return badRequest('usuario_id requerido');

    const { data: target, error: tErr } = await admin
      .from('usuarios')
      .select('id, tenant_id, avatar_url, identidad_completa, contrato_firmado')
      .eq('id', usuarioId)
      .maybeSingle();
    if (tErr) return serverError(tErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro pertenece a otro estudio');

    // ---- GET: leer la ficha ----
    if (event.httpMethod === 'GET') {
      const { data: dp } = await admin
        .from('usuarios_datos_privados')
        .select('fecha_nacimiento, domicilio, ine_folio, ine_foto_path')
        .eq('usuario_id', usuarioId)
        .maybeSingle();

      let ine_foto_url: string | null = null;
      if (dp?.ine_foto_path) {
        const { data: signed } = await admin.storage
          .from('identidad')
          .createSignedUrl(dp.ine_foto_path, 300); // 5 min
        ine_foto_url = signed?.signedUrl ?? null;
      }

      return ok({
        fecha_nacimiento: dp?.fecha_nacimiento ?? null,
        domicilio: dp?.domicilio ?? null,
        ine_folio: dp?.ine_folio ?? null,
        ine_foto_url,
        tiene_foto: !!target.avatar_url,
        identidad_completa: target.identidad_completa,
        contrato_firmado: target.contrato_firmado
      });
    }

    if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

    // ---- POST: guardar ----
    const body: Body = JSON.parse(event.body || '{}');

    // Datos previos (para no perder ine_foto_path si no se resube).
    const { data: prev } = await admin
      .from('usuarios_datos_privados')
      .select('ine_foto_path')
      .eq('usuario_id', usuarioId)
      .maybeSingle();

    let ineFotoPath: string | null = prev?.ine_foto_path ?? null;
    if (body.ine_foto?.base64 && body.ine_foto.contentType) {
      const buffer = Buffer.from(body.ine_foto.base64, 'base64');
      const ext = extFromContentType(body.ine_foto.contentType);
      const path = `${caller.tenant_id}/${usuarioId}-ine.${ext}`;
      const { error: upErr } = await admin.storage
        .from('identidad')
        .upload(path, buffer, { contentType: body.ine_foto.contentType, upsert: true });
      if (upErr) return serverError(`No se pudo subir la INE: ${upErr.message}`);
      ineFotoPath = path;
    }

    const fechaNac = body.fecha_nacimiento?.trim() || null;
    const domicilio = body.domicilio?.trim() || null;
    const ineFolio = body.ine_folio?.trim() || null;

    const { error: dpErr } = await admin
      .from('usuarios_datos_privados')
      .upsert(
        {
          usuario_id: usuarioId,
          tenant_id: target.tenant_id,
          fecha_nacimiento: fechaNac,
          domicilio,
          ine_folio: ineFolio,
          ine_foto_path: ineFotoPath,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'usuario_id' }
      );
    if (dpErr) return serverError(dpErr.message);

    // Recalcular el gate: foto + nacimiento + domicilio + INE.
    const completa = !!target.avatar_url && !!fechaNac && !!domicilio && !!ineFotoPath;
    const contratoFirmado = body.contrato_firmado === true;

    const patch: Record<string, unknown> = { identidad_completa: completa };
    if (contratoFirmado) {
      patch.contrato_firmado = true;
      patch.contrato_firmado_at = new Date().toISOString();
    }
    const { error: uErr } = await admin.from('usuarios').update(patch).eq('id', usuarioId);
    if (uErr) return serverError(uErr.message);

    // Audit SIN valores sensibles (H4): solo qué se tocó.
    await writeAuditLog(admin, {
      tenant_id: target.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'ficha_identidad_actualizada',
      target_tipo: 'usuario',
      target_id: usuarioId,
      metadata: {
        identidad_completa: completa,
        contrato_firmado: contratoFirmado,
        subio_ine: !!body.ine_foto?.base64
      }
    });

    return ok({ success: true, identidad_completa: completa, contrato_firmado: contratoFirmado });
  } catch (e) {
    console.error('[reception-datos-identidad]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
