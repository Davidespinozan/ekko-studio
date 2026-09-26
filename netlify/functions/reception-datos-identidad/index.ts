import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { esStaffActivo, puedeOperarSobre } from '../_lib/staff';

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
 * Semántica PATCH (Fase 1 de identidad, 2026-09-25). Antes un campo omitido
 * terminaba en NULL: una carga fallida del modal borraba la ficha entera.
 *   · campo AUSENTE (undefined)      → se conserva el valor actual
 *   · campo con texto                → se actualiza (trim)
 *   · campo vacío ('')               → ambiguo: se conserva (no es un borrado)
 *   · null explícito                 → borrado intencional (la UI hoy no lo manda)
 *   · ine_foto ausente               → se conserva la foto
 * `contrato_firmado`: false→true fija contrato_firmado_at = now(); true→true no
 * toca la fecha (es un evento histórico); true→false se ignora: quitar una
 * firma requiere una operación propia y auditada, no un checkbox.
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

/**
 * PATCH de un campo de texto: ausente o vacío conserva; null borra; texto actualiza.
 * Exportado para test.
 */
export function fusionarCampo(
  nuevo: string | null | undefined,
  actual: string | null
): { valor: string | null; cambio: boolean } {
  if (nuevo === undefined) return { valor: actual, cambio: false };
  if (nuevo === null) return { valor: null, cambio: actual !== null };
  const v = String(nuevo).trim();
  if (!v) return { valor: actual, cambio: false };
  return { valor: v, cambio: v !== actual };
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
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) {
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
      .select('id, tenant_id, rol, avatar_url, identidad_completa, contrato_firmado')
      .eq('id', usuarioId)
      .maybeSingle();
    if (tErr) return serverError(tErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro pertenece a otro estudio');
    // Recepción solo ve/edita la ficha (INE, domicilio) de MIEMBROS, no del equipo.
    if (!puedeOperarSobre(caller, target)) {
      return forbidden('Solo un admin puede ver o modificar las cuentas del equipo');
    }

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

    // Estado actual: la base de la fusión (PATCH), no un formulario.
    const { data: prev, error: prevErr } = await admin
      .from('usuarios_datos_privados')
      .select('fecha_nacimiento, domicilio, ine_folio, ine_foto_path')
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (prevErr) return serverError(prevErr.message);

    const fecha = fusionarCampo(body.fecha_nacimiento, prev?.fecha_nacimiento ?? null);
    const domicilio = fusionarCampo(body.domicilio, prev?.domicilio ?? null);
    const ineFolio = fusionarCampo(body.ine_folio, prev?.ine_folio ?? null);
    if (fecha.valor && !/^\d{4}-\d{2}-\d{2}$/.test(fecha.valor)) {
      return badRequest('fecha_nacimiento debe ser YYYY-MM-DD');
    }

    let ineFotoPath: string | null = prev?.ine_foto_path ?? null;
    let subioIne = false;
    if (body.ine_foto?.base64 && body.ine_foto.contentType) {
      const buffer = Buffer.from(body.ine_foto.base64, 'base64');
      const ext = extFromContentType(body.ine_foto.contentType);
      const path = `${caller.tenant_id}/${usuarioId}-ine.${ext}`;
      const { error: upErr } = await admin.storage
        .from('identidad')
        .upload(path, buffer, { contentType: body.ine_foto.contentType, upsert: true });
      if (upErr) return serverError(`No se pudo subir la INE: ${upErr.message}`);
      ineFotoPath = path;
      subioIne = true;
    }

    const cambios: string[] = [];
    if (fecha.cambio) cambios.push('fecha_nacimiento');
    if (domicilio.cambio) cambios.push('domicilio');
    if (ineFolio.cambio) cambios.push('ine_folio');
    if (subioIne) cambios.push('ine_foto');

    // Solo se escribe si hay algo que escribir: un POST sin cambios no crea ni
    // pisa nada.
    if (cambios.length > 0) {
      const { error: dpErr } = await admin
        .from('usuarios_datos_privados')
        .upsert(
          {
            usuario_id: usuarioId,
            tenant_id: target.tenant_id,
            fecha_nacimiento: fecha.valor,
            domicilio: domicilio.valor,
            ine_folio: ineFolio.valor,
            ine_foto_path: ineFotoPath,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'usuario_id' }
        );
      if (dpErr) return serverError(dpErr.message);
    }

    // Recalcular el gate con los valores FUSIONADOS: foto + nacimiento + domicilio + INE.
    // (La base también lo recalcula por trigger; aquí se deja explícito.)
    const completa = !!target.avatar_url && !!fecha.valor && !!domicilio.valor && !!ineFotoPath;

    // Contrato: la fecha de firma es un evento histórico.
    let contratoFirmado = target.contrato_firmado === true;
    let contratoRecienFirmado = false;
    const contratoIgnorado = body.contrato_firmado === false && contratoFirmado;
    if (body.contrato_firmado === true && !contratoFirmado) {
      contratoFirmado = true;
      contratoRecienFirmado = true;
      cambios.push('contrato_firmado');
    }

    const patch: Record<string, unknown> = {};
    if (completa !== (target.identidad_completa === true)) patch.identidad_completa = completa;
    if (contratoRecienFirmado) {
      patch.contrato_firmado = true;
      patch.contrato_firmado_at = new Date().toISOString();
    }
    if (Object.keys(patch).length > 0) {
      const { error: uErr } = await admin.from('usuarios').update(patch).eq('id', usuarioId);
      if (uErr) return serverError(uErr.message);
    }

    // Audit SIN valores sensibles (H4): solo qué se tocó.
    if (cambios.length > 0 || Object.keys(patch).length > 0) {
      await writeAuditLog(admin, {
        tenant_id: target.tenant_id,
        actor_usuario_id: caller.id,
        actor_rol: caller.rol,
        accion: 'ficha_identidad_actualizada',
        target_tipo: 'usuario',
        target_id: usuarioId,
        metadata: {
          campos: cambios,
          identidad_completa: completa,
          contrato_firmado: contratoFirmado,
          contrato_recien_firmado: contratoRecienFirmado,
          contrato_desmarcado_ignorado: contratoIgnorado,
          subio_ine: subioIne
        }
      });
    }

    return ok({
      success: true,
      identidad_completa: completa,
      contrato_firmado: contratoFirmado,
      cambios,
      ...(contratoIgnorado ? { aviso: 'El contrato ya estaba firmado: quitar la firma no se hace desde aquí.' } : {})
    });
  } catch (e) {
    console.error('[reception-datos-identidad]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
