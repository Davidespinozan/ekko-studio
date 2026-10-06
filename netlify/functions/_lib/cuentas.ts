import type { HandlerResponse } from '@netlify/functions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportarErrorServidor } from './sentry';

/**
 * PKG-06A · Operaciones compuestas de cuenta.
 *
 * La parte LOCAL de cada operación (perfil, rol, status, auditoría con actor) vive
 * en una RPC de servicio que corre en UNA transacción; aquí solo se autentica al
 * caller, se ordena lo que toca al proveedor de Auth y se responde con honestidad
 * cuando una mitad quedó hecha y la otra no. No hay atomicidad distribuida: se
 * compensa por propiedad (solo se borra lo que ESTA operación creó).
 */

const baseHeaders = { 'Content-Type': 'application/json' };

/** Código EKKO_* y texto humano de un error de RPC (`EKKO_CODIGO: mensaje`). */
export function codigoRpc(message: string | undefined | null): { codigo: string | null; texto: string } {
  const m = message ?? '';
  const match = /EKKO_([A-Z_]+):\s*(.*)$/s.exec(m);
  if (!match) return { codigo: null, texto: m };
  return { codigo: match[1], texto: match[2].trim() };
}

const STATUS_POR_CODIGO: Record<string, number> = {
  NO_AUTH: 401,
  NO_AUTORIZADO: 403,
  MIEMBRO_INVALIDO: 404,
  PERFIL_NO_ENCONTRADO: 404,
  ULTIMO_ADMIN: 409,
  PERFIL_CON_HISTORIAL: 409,
  ROL_DISTINTO: 409,
  PERFIL_DISTINTO: 409,
  IDENTIDAD_AMBIGUA: 409
};

/**
 * Traduce el error de una RPC de cuenta a la respuesta HTTP. Los códigos EKKO_*
 * traen mensaje humano en español; cualquier otro error NO se filtra al cliente
 * (se reporta y se responde genérico).
 */
export async function respuestaErrorRpc(
  funcion: string,
  err: { message?: string } | null | undefined,
  contexto: Record<string, unknown> = {}
): Promise<HandlerResponse> {
  const { codigo, texto } = codigoRpc(err?.message);
  if (codigo) {
    return {
      statusCode: STATUS_POR_CODIGO[codigo] ?? 400,
      headers: baseHeaders,
      body: JSON.stringify({ error: texto, codigo })
    };
  }
  await reportarErrorServidor(funcion, new Error(err?.message ?? 'error_desconocido'), contexto);
  return {
    statusCode: 500,
    headers: baseHeaders,
    body: JSON.stringify({ error: 'No se pudo completar la operación. Intenta de nuevo.', codigo: 'interno', seguro: true })
  };
}

export function conflicto(error: string, extra: Record<string, unknown> = {}): HandlerResponse {
  return { statusCode: 409, headers: baseHeaders, body: JSON.stringify({ error, ...extra }) };
}

export function esCorreoYaRegistrado(message: string | undefined | null): boolean {
  const m = (message ?? '').toLowerCase();
  return m.includes('already') || m.includes('exists') || m.includes('registered');
}

/** Lo que las dos functions de alta mandan a la RPC; `rol` ya validado por el caller. */
export interface AltaArgs {
  funcion: string;
  admin: SupabaseClient;
  actorId: string;
  email: string;
  password: string;
  nombre: string;
  telefono: string | null;
  rol: 'miembro' | 'recepcionista' | 'admin';
  tier: string | null;
  /** Alta explícita sobre un perfil existente SIN acceso (autoriza vincular aunque tenga historial). */
  perfilId: string | null;
}

export interface AltaOk {
  ok: true;
  usuario_id: string;
  modo: 'nueva' | 'vincular';
  rol: string;
  status: string;
  /** Un intento anterior ya la había dejado hecha; no se repitió nada. */
  recuperada: boolean;
}

type Preparada = {
  modo: 'nueva' | 'vincular' | 'recuperar' | 'existente' | 'ambiguo' | 'perfil_con_historial' | 'rol_distinto';
  modo_original?: 'nueva' | 'vincular';
  auth_id?: string;
  perfil_id?: string;
  rol_perfil?: string;
  historial?: Record<string, number>;
};

type Finalizada = { success: boolean; idempotente: boolean; usuario_id: string; rol: string; status: string };

/**
 * Alta de una cuenta (Auth + perfil) con frontera del servidor:
 *  1) `cuenta_alta_preparar` decide con el estado REAL qué pasará con ese correo
 *     (antes de tocar Auth): perfil nuevo, vinculación elegible, o rechazo honesto.
 *  2) `auth.admin.createUser` (el trigger crea el cascarón o vincula el perfil
 *     elegible). Si Auth dice "ya existe", se intenta RECUPERAR un alta anterior
 *     que quedó a medias (perfil vinculado sin finalizar) o limpiar una cuenta de
 *     Auth sin perfil; si nada de eso aplica, es un correo tomado de verdad.
 *  3) `cuenta_alta_finalizar` fija rol/status/plan + aviso + auditoría con actor.
 *  Compensación por PROPIEDAD: si el perfil lo creó ESTA alta ('nueva') y el paso 3
 *  falla, se borra la cuenta de Auth (su cascada solo alcanza el cascarón). Si se
 *  vinculó un perfil preexistente, NUNCA se borra: se responde el estado parcial y
 *  el reintento con el mismo correo converge.
 */
export async function altaDeCuenta(a: AltaArgs): Promise<AltaOk | HandlerResponse> {
  const email = a.email.trim().toLowerCase();
  const { data: prepData, error: prepErr } = await a.admin.rpc('cuenta_alta_preparar', {
    p_actor_id: a.actorId,
    p_email: email,
    p_rol: a.rol,
    p_perfil_id: a.perfilId
  });
  if (prepErr) return respuestaErrorRpc(a.funcion, prepErr, { paso: 'preparar' });
  const prep = (prepData ?? {}) as Preparada;

  switch (prep.modo) {
    case 'existente':
      return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: 'Ya existe una cuenta con ese email' }) };
    case 'ambiguo':
      return conflicto('Hay más de un perfil con ese correo en el estudio; resuélvelo antes de crear la cuenta.');
    case 'rol_distinto':
      return conflicto(
        `Ya existe un perfil con ese correo y es ${prep.rol_perfil}; no se reescribe al crearle acceso.`,
        { perfil_id: prep.perfil_id, rol_perfil: prep.rol_perfil }
      );
    case 'perfil_con_historial':
      return conflicto(
        'Ya existe un perfil con historial para ese correo (sin acceso). El acceso se crea desde su ficha, confirmando ese perfil.',
        { perfil_id: prep.perfil_id, historial: prep.historial ?? {} }
      );
    case 'nueva':
    case 'vincular':
    case 'recuperar':
      break;
    default:
      return respuestaErrorRpc(a.funcion, { message: `modo desconocido: ${String(prep.modo)}` }, { paso: 'preparar' });
  }

  let authId: string | null = null;
  let modo: 'nueva' | 'vincular';
  // Un alta anterior quedó a medias (Auth sí, finalización no): no se toca Auth y
  // se finaliza con el modo con que empezó. El reintento converge sin duplicar.
  const recuperada = prep.modo === 'recuperar';
  if (prep.modo === 'recuperar') {
    authId = prep.auth_id ?? null;
    modo = prep.modo_original ?? 'nueva';
    if (!authId) return respuestaErrorRpc(a.funcion, { message: 'recuperar sin auth_id' }, { paso: 'preparar' });
  } else {
    modo = prep.modo;
    const metadata = { tenant_slug: 'ekko', nombre: a.nombre, telefono: a.telefono };
    let creado = await a.admin.auth.admin.createUser({ email, password: a.password, email_confirm: true, user_metadata: metadata });

    if ((creado.error || !creado.data?.user) && esCorreoYaRegistrado(creado.error?.message)) {
      // Auth ya tiene ese correo pero aquí no hay perfil con acceso: es una cuenta de
      // Auth sin ningún perfil (compensación anterior incompleta) o pertenece a otro
      // estudio. Solo la primera se limpia: nada cascadea porque no hay fila.
      const { data: huerfano } = await a.admin.rpc('auth_usuario_sin_perfil', { p_email: email });
      if (!huerfano) {
        return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: 'Ya existe una cuenta con ese email' }) };
      }
      const { error: delHuerfano } = await a.admin.auth.admin.deleteUser(String(huerfano));
      if (delHuerfano) return respuestaErrorRpc(a.funcion, { message: delHuerfano.message }, { paso: 'limpiar_auth_sin_perfil' });
      creado = await a.admin.auth.admin.createUser({ email, password: a.password, email_confirm: true, user_metadata: metadata });
    }

    if (creado.error || !creado.data?.user) {
      const { codigo, texto } = codigoRpc(creado.error?.message);
      // El trigger de alta rechazó (perfil con historial sin autorizar, identidad ambigua…).
      if (codigo) return { statusCode: STATUS_POR_CODIGO[codigo] ?? 409, headers: baseHeaders, body: JSON.stringify({ error: texto, codigo }) };
      if (esCorreoYaRegistrado(creado.error?.message)) {
        return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: 'Ya existe una cuenta con ese email' }) };
      }
      await reportarErrorServidor(a.funcion, new Error(creado.error?.message ?? 'sin usuario'), { paso: 'auth.createUser' });
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'No se pudo crear la cuenta de acceso. Intenta de nuevo.', seguro: true }) };
    }
    authId = creado.data.user.id;
  }

  const { data: finData, error: finErr } = await a.admin.rpc('cuenta_alta_finalizar', {
    p_actor_id: a.actorId,
    p_auth_id: authId,
    p_rol: a.rol,
    p_tier: a.rol === 'miembro' ? a.tier : null,
    p_nombre: a.nombre,
    p_telefono: a.telefono,
    p_modo: modo
  });

  if (finErr) {
    const { codigo, texto } = codigoRpc(finErr.message);
    if (modo === 'nueva' && !recuperada) {
      // El perfil (cascarón) lo creó ESTA alta: borrar la cuenta de Auth solo
      // arrastra ese cascarón. Si la limpieza falla, se dice.
      const { error: delErr } = await a.admin.auth.admin.deleteUser(authId);
      if (delErr) {
        await reportarErrorServidor(a.funcion, new Error(delErr.message), { paso: 'compensar_auth', auth_id: authId });
        return {
          statusCode: 500,
          headers: baseHeaders,
          body: JSON.stringify({
            error: `La cuenta de acceso se creó pero no se pudo completar el alta (${codigo ? texto : 'error del servidor'}) y tampoco revertirla. Vuelve a intentarlo con el mismo correo: se completará.`,
            seguro: true,
            parcial: { acceso_creado: true, perfil_finalizado: false }
          })
        };
      }
      if (codigo) return { statusCode: STATUS_POR_CODIGO[codigo] ?? 400, headers: baseHeaders, body: JSON.stringify({ error: `${texto} Se revirtió la cuenta de acceso.`, codigo }) };
      await reportarErrorServidor(a.funcion, new Error(finErr.message), { paso: 'finalizar', modo });
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'No se pudo completar el alta; se revirtió la cuenta de acceso. Intenta de nuevo.', seguro: true }) };
    }
    // Perfil preexistente vinculado (o alta recuperada): NUNCA se borra nada.
    await reportarErrorServidor(a.funcion, new Error(finErr.message), { paso: 'finalizar', modo, auth_id: authId });
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({
        error: `El acceso quedó creado y vinculado al perfil, pero no se pudo completar el alta${codigo ? `: ${texto}` : ''}. Vuelve a intentarlo con el mismo correo: se completará sin duplicar nada.`,
        seguro: true,
        parcial: { acceso_creado: true, perfil_finalizado: false }
      })
    };
  }

  const fin = (finData ?? {}) as Finalizada;
  return { ok: true, usuario_id: fin.usuario_id, modo, rol: fin.rol, status: fin.status, recuperada };
}

export function esAltaOk(r: AltaOk | HandlerResponse): r is AltaOk {
  return (r as AltaOk).ok === true;
}
