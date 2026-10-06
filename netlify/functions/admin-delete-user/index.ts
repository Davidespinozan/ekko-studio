import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { esAdminActivo } from '../_lib/staff';
import { conflicto, respuestaErrorRpc } from '../_lib/cuentas';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /admin-delete-user
 * Auth: Bearer JWT del admin
 * Body: { usuario_id, motivo? }
 *
 * PKG-06A · D-FIN-1 = A: el borrado físico SOLO procede para una cuenta
 * desechable, sin historial durable (membresías, ledger de créditos, pagos,
 * reservas, ventas, material, reversales, operaciones/discrepancias de Stripe,
 * notas, cliente de Stripe) ni huella como staff (check-ins, cancelaciones, notas,
 * bitácora, ventas, revisiones…). Con historial se responde 409 y se manda a
 * "Revocar acceso", que conserva la evidencia. La guardia vive en la RPC
 * `cuenta_eliminar` (una transacción): deja `cuenta_eliminada` con el actor ANTES
 * del DELETE (target_id sin FK: sobrevive) y borra la fila local. Después se borra
 * la cuenta de Auth; si eso falla, se dice (el perfil ya no existe) y el siguiente
 * alta con ese correo limpia la cuenta de Auth huérfana.
 *
 * Guards de autoridad (también en la RPC): admin activo del tenant; target del
 * mismo tenant; no a sí mismo; nunca al último admin activo (trigger + RPC).
 */

interface DeleteUserRequest {
  usuario_id: string;
  motivo?: string;
}

const NOMBRES: Record<string, string> = {
  membresias: 'membresías',
  movimientos: 'movimientos de créditos',
  pagos: 'cobros registrados',
  reservas: 'reservas en historial',
  ventas_mostrador: 'ventas de mostrador',
  material: 'archivos de material',
  reversales: 'reembolsos o disputas',
  operaciones_stripe: 'operaciones de cobro',
  discrepancias_stripe: 'discrepancias con Stripe',
  correos_directos: 'correos del cobro',
  notas: 'notas del equipo sobre la persona',
  cliente_stripe: 'cliente en Stripe',
  bitacora: 'acciones en la bitácora',
  checkins: 'check-ins registrados por esta persona',
  cancelaciones: 'cancelaciones hechas por esta persona',
  notas_escritas: 'notas escritas por esta persona',
  ventas_registradas: 'ventas registradas por esta persona',
  material_subido: 'material subido por esta persona',
  invitados_registrados: 'invitados registrados por esta persona',
  revisiones: 'revisiones financieras hechas por esta persona',
  eventos_revisados: 'eventos de Stripe revisados por esta persona',
  operaciones_revisadas: 'operaciones revisadas por esta persona',
  discrepancias_revisadas: 'discrepancias revisadas por esta persona',
  correos_revisados: 'correos revisados por esta persona',
  accesos_autorizados: 'accesos autorizados por esta persona'
};

function describir(historial: Record<string, number>): string {
  return Object.entries(historial)
    .map(([k, n]) => `${n} ${NOMBRES[k] ?? k}`)
    .join(', ');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: DeleteUserRequest = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: adminProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!esAdminActivo(adminProfile)) {
      return forbidden('Solo admin puede eliminar usuarios');
    }

    if (adminProfile.id === body.usuario_id) {
      return badRequest('No puedes eliminarte a ti mismo');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // Guardia + evidencia + DELETE local: UNA transacción en el servidor.
    const { data, error } = await supabaseAdmin.rpc('cuenta_eliminar', {
      p_actor_id: adminProfile.id,
      p_usuario_id: body.usuario_id,
      p_motivo: typeof body.motivo === 'string' ? body.motivo : null
    });
    if (error) return respuestaErrorRpc('admin-delete-user', error, { usuario_id: body.usuario_id });

    const r = (data ?? {}) as {
      permitido: boolean;
      usuario_id: string;
      auth_id?: string | null;
      historial?: Record<string, number>;
      huella_staff?: Record<string, number>;
    };

    if (!r.permitido) {
      const todo = { ...(r.historial ?? {}), ...(r.huella_staff ?? {}) };
      return conflicto(
        `No se puede eliminar: tiene ${describir(todo)}. Para quitarle el acceso usa "Revocar acceso": conserva el historial y le quita la entrada.`,
        { historial: r.historial ?? {}, huella_staff: r.huella_staff ?? {} }
      );
    }

    // El perfil ya no existe. Ahora la cuenta de Auth (fuera de la transacción).
    if (r.auth_id) {
      const { error: authDelErr } = await supabaseAdmin.auth.admin.deleteUser(r.auth_id);
      if (authDelErr) {
        await reportarErrorServidor('admin-delete-user', new Error(authDelErr.message), { paso: 'auth.deleteUser', usuario_id: body.usuario_id });
        return ok({
          success: true,
          deleted: { id: r.usuario_id },
          acceso_eliminado: false,
          aviso: 'El perfil se eliminó, pero la cuenta de acceso del proveedor no se pudo borrar todavía. Se limpiará sola al volver a dar de alta ese correo.'
        });
      }
    }

    return ok({ success: true, deleted: { id: r.usuario_id }, acceso_eliminado: true });
  } catch (e) {
    console.error('[admin-delete-user]', e);
    return serverError('No se pudo eliminar la cuenta. Intenta de nuevo.');
  }
};
