// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-06G · migración 20261015100000 contra Postgres real (PGlite).
 *
 * Sin Sentry, la salud de los procesos programados vive en `procesos_programados`
 * (estado actual, una fila por proceso) y el atraso se DERIVA al leer
 * `v_pendientes_operativos`: un cron muerto se ve sin tener que reportarse. La
 * reconciliación usa sus propias corridas (03B). Los push no entregados salen
 * agregados por estudio, sin destinatario ni contenido.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let miembro: Persona;
let adminB: Persona;
let tenantB: string;

type Pend = { dominio: string; tipo: string; fuente: string; fuente_id: string; severidad: string; accion: string; detalle: string | null; usuario_id: string | null; tenant_id: string };
const pendientes = (p: Persona) => b.como(p, () => b.filas<Pend>('SELECT * FROM v_pendientes_operativos'));
const deProcesos = async (p: Persona) => (await pendientes(p)).filter((x) => x.fuente === 'procesos_programados');
const registrar = (proceso: string, estado: string, clase: string | null = null) =>
  b.fila<{ r: Record<string, unknown> }>('SELECT registrar_ejecucion_proceso($1, $2, $3) AS r', [proceso, estado, clase]).then((x) => x.r);
const estado = (proceso: string) => b.fila<{ ultimo_estado: string | null; fallos_seguidos: number; ultimo_exito_at: string | null; ultimo_fallo_at: string | null; ultima_clase_error: string | null }>(
  'SELECT ultimo_estado, fallos_seguidos, ultimo_exito_at, ultimo_fallo_at, ultima_clase_error FROM procesos_programados WHERE proceso = $1', [proceso]);
/** Mueve el reloj de un proceso hacia atrás (el tiempo no se fabrica en producción; aquí sí). */
const envejecer = (proceso: string, campo: 'ultimo_exito_at' | 'vigilado_desde', haceSql: string) =>
  b.db.query(`UPDATE procesos_programados SET ${campo} = now() - interval '${haceSql}' WHERE proceso = $1`, [proceso]);
const sanos = async () => {
  for (const p of ['cron-expirar-membresias', 'cron-no-shows', 'cron-email', 'cron-push', 'cron-recordatorios', 'cron-material-vencido']) await registrar(p, 'exito');
};
const aviso = async (p: Persona, resultado: string | null, tipo = 'recordatorio_reserva', tenant = b.tenantId) =>
  (await b.fila<{ id: string }>(
    `INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, push_resultado, push_enviado_at)
     VALUES ($1, $2, $3, 'Título', 'Contenido privado', $4, CASE WHEN $4 = 'enviado' THEN now() END) RETURNING id`,
    [tenant, p.id, tipo, resultado])).id;

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  miembro = await b.crearPersona();
  tenantB = (await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06g', 'Otro', 'activo') RETURNING id`)).id;
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-06g@test.mx', '{"tenant_slug":"b-06g"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('catálogo y escritura', () => {
  it('1/2/3 · catálogo: 6 procesos que importan; sin latido para la reconciliación (su evidencia es la corrida) ni para los de cortesía', async () => {
    const filas = await b.filas<{ proceso: string; severidad: string; umbral_atraso: string }>('SELECT proceso, severidad, umbral_atraso::text FROM procesos_programados ORDER BY proceso');
    expect(filas.map((f) => f.proceso)).toEqual(['cron-email', 'cron-expirar-membresias', 'cron-material-vencido', 'cron-no-shows', 'cron-push', 'cron-recordatorios']);
    expect(filas.find((f) => f.proceso === 'cron-expirar-membresias')).toMatchObject({ severidad: 'alta', umbral_atraso: '26:00:00' });
    await expect(registrar('cron-reconciliar-stripe', 'exito')).rejects.toThrow(/EKKO_PROCESO_DESCONOCIDO/);
    await expect(registrar('cron-felicitaciones', 'exito')).rejects.toThrow(/EKKO_PROCESO_DESCONOCIDO/);
  });

  it('11/15 · recién vigilado: nada (ventana de primera corrida); nunca corrió tras max(umbral, 2 h): atrasado', async () => {
    expect(await deProcesos(admin)).toEqual([]);
    await envejecer('cron-push', 'vigilado_desde', '90 minutes'); // > 15 min pero < 2 h
    expect(await deProcesos(admin)).toEqual([]);
    await envejecer('cron-push', 'vigilado_desde', '3 hours');
    const [x] = await deProcesos(admin);
    expect(x).toMatchObject({ dominio: 'procesos', tipo: 'proceso_atrasado', fuente_id: 'cron-push', severidad: 'media', accion: 'revisar_proceso' });
    expect(x.detalle).toContain('nunca corrió');
  });

  it('4/6/17 · éxito asentado al terminar: estado actual (no un log), fallos a cero, deja de aparecer', async () => {
    await sanos();
    await sanos();
    expect(await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM procesos_programados')).toEqual({ n: 6 });
    expect(await estado('cron-push')).toMatchObject({ ultimo_estado: 'exito', fallos_seguidos: 0, ultima_clase_error: null });
    expect(await deProcesos(admin)).toEqual([]);
  });

  it('5/7/8 · fallo honesto con clase fija; un fallo aislado de un proceso frecuente no es trabajo; N seguidos sí, UNA fila', async () => {
    await registrar('cron-push', 'fallo', 'base_datos');
    expect(await estado('cron-push')).toMatchObject({ ultimo_estado: 'fallo', fallos_seguidos: 1, ultima_clase_error: 'base_datos' });
    expect(await deProcesos(admin)).toEqual([]); // push: 10 fallos seguidos para avisar
    for (let i = 0; i < 9; i++) await registrar('cron-push', 'fallo', 'base_datos');
    const lista = await deProcesos(admin);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ tipo: 'proceso_fallando', fuente_id: 'cron-push' });
    expect(lista[0].detalle).toContain('10 fallos seguidos');
    await expect(registrar('cron-push', 'fallo', 'Error: connection refused at 10.0.0.1')).rejects.toThrow(/EKKO_CLASE_INVALIDA/);
    await expect(registrar('cron-push', 'corriendo')).rejects.toThrow(/EKKO_ESTADO_INVALIDO/);
    await registrar('cron-push', 'exito');
    expect(await deProcesos(admin)).toEqual([]);
  });

  it('crítico diario: un solo fallo ya es trabajo (alta); parcial cuenta éxito y fallo', async () => {
    await registrar('cron-expirar-membresias', 'fallo', 'base_datos');
    expect((await deProcesos(admin))[0]).toMatchObject({ fuente_id: 'cron-expirar-membresias', tipo: 'proceso_fallando', severidad: 'alta' });
    await registrar('cron-expirar-membresias', 'parcial', 'proveedor');
    const e = await estado('cron-expirar-membresias');
    expect(e).toMatchObject({ ultimo_estado: 'parcial', fallos_seguidos: 2, ultima_clase_error: 'proveedor' });
    expect(e.ultimo_exito_at).not.toBeNull();
    expect((await deProcesos(admin))[0].detalle).toContain('parcial (proveedor)');
    await registrar('cron-expirar-membresias', 'exito');
    expect(await deProcesos(admin)).toEqual([]);
  });

  it('12/13/14/16 · atraso por umbral propio: un retraso normal no alarma; un cron muerto sí, sin que él lo reporte', async () => {
    await envejecer('cron-no-shows', 'ultimo_exito_at', '2 hours'); // horario: umbral 3 h
    expect(await deProcesos(admin)).toEqual([]);
    await envejecer('cron-no-shows', 'ultimo_exito_at', '4 hours');
    await envejecer('cron-email', 'ultimo_exito_at', '25 minutes'); // */2: umbral 20 min
    await envejecer('cron-expirar-membresias', 'ultimo_exito_at', '25 hours'); // diario: aún no
    const lista = await deProcesos(admin);
    expect(lista.map((x) => [x.fuente_id, x.tipo, x.severidad]).sort()).toEqual([
      ['cron-email', 'proceso_atrasado', 'media'], ['cron-no-shows', 'proceso_atrasado', 'alta']
    ]);
    await sanos();
    expect(await deProcesos(admin)).toEqual([]);
  });

  it('omitido (sin configuración) no cuenta como éxito: se atrasa y lo dice', async () => {
    await registrar('cron-email', 'omitido', 'configuracion');
    await envejecer('cron-email', 'ultimo_exito_at', '1 hour');
    const [x] = await deProcesos(admin);
    expect(x).toMatchObject({ fuente_id: 'cron-email', tipo: 'proceso_atrasado' });
    expect(x.detalle).toContain('omitido (configuracion)');
    await sanos();
  });

  it('9/10 · el navegador no escribe ni forja estado; la escritura es solo de service_role', async () => {
    await expect(b.como(admin, () => b.fila(`SELECT registrar_ejecucion_proceso('cron-push', 'exito', NULL)`))).rejects.toThrow(/permission denied/);
    await expect(b.como(admin, () => b.db.query(`UPDATE procesos_programados SET ultimo_exito_at = now()`))).rejects.toThrow(/permission denied/);
    await expect(b.como(miembro, () => b.filas('SELECT * FROM procesos_programados'))).resolves.toEqual([]);
    const p = await b.fila<{ an: boolean; au: boolean; s: boolean }>(
      `SELECT has_function_privilege('anon', 'registrar_ejecucion_proceso(text, text, text)', 'EXECUTE') AS an, has_function_privilege('authenticated', 'registrar_ejecucion_proceso(text, text, text)', 'EXECUTE') AS au, has_function_privilege('service_role', 'registrar_ejecucion_proceso(text, text, text)', 'EXECUTE') AS s`);
    expect(p).toEqual({ an: false, au: false, s: true });
  });
});

describe('03B: la reconciliación se vigila con sus propias corridas', () => {
  const corrida = (hace: string, estadoC = 'completa', tenant = b.tenantId) =>
    b.db.query(`INSERT INTO reconciliacion_stripe_corridas (corrida_id, tenant_id, estado, iniciada_at, terminada_at, suscripciones_leidas)
                VALUES (gen_random_uuid(), $1, $2, now() - $3::interval, now() - $3::interval, 0)`, [tenant, estadoC, hace]);
  const deRecon = async (p: Persona) => (await pendientes(p)).filter((x) => x.tipo.startsWith('reconciliacion_'));

  it('18/19/20 · sin corridas: nada; corrida reciente: nada; la última de hace >26 h: atrasada (derivado, sin correr nada)', async () => {
    expect(await deRecon(admin)).toEqual([]);
    await corrida('30 hours');
    expect((await deRecon(admin)).map((x) => x.tipo)).toEqual(['reconciliacion_atrasada']);
    await corrida('2 hours');
    expect(await deRecon(admin)).toEqual([]);
    const cols = await b.filas<{ n: number }>(`SELECT count(*)::int AS n FROM procesos_programados WHERE proceso LIKE '%reconciliar%'`);
    expect(cols[0].n).toBe(0);
  });

  it('una corrida incompleta sigue saliendo por su rama de 03B (sin cambios)', async () => {
    await corrida('1 hour', 'parcial');
    expect((await deRecon(admin)).map((x) => x.tipo)).toEqual(['reconciliacion_parcial']);
    await corrida('5 minutes');
  });
});

describe('FR-51 · avisos push no entregados', () => {
  it('21/22 · enviado, sin suscripción o pendiente: nada', async () => {
    await aviso(miembro, 'enviado');
    await aviso(miembro, 'sin_suscripcion');
    await aviso(miembro, null);
    expect((await pendientes(admin)).filter((x) => x.fuente === 'notificaciones_push')).toEqual([]);
  });

  it('23/25 · fallo (terminal: no hay reintento) y sin configuración: UNA fila por estudio, sin destinatario ni contenido', async () => {
    await aviso(miembro, 'fallo');
    await aviso(miembro, 'fallo', 'membresia_por_vencer');
    await aviso(miembro, 'sin_config');
    const push = (await pendientes(admin)).filter((x) => x.fuente === 'notificaciones_push');
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({ dominio: 'entrega', tipo: 'push_no_entregado', severidad: 'baja', accion: 'revisar_fallos_push', usuario_id: null });
    expect(push[0].detalle).toBe('3 sin entregar (1 por falta de configuración) · membresia_por_vencer, recordatorio_reserva');
    expect(JSON.stringify(push[0])).not.toMatch(/Contenido privado|endpoint|p256dh|Título/);
  });

  it('25b · la política de avisos no se amplía: el admin no lee por REST los avisos push fallidos de otros; el resumen no sirve a miembros ni a anon', async () => {
    expect(await b.como(admin, () => b.filas(`SELECT id FROM notificaciones WHERE push_resultado = 'fallo' AND usuario_id = $1`, [miembro.id]))).toEqual([]);
    expect(await b.como(miembro, () => b.filas('SELECT * FROM resumen_fallos_push()'))).toEqual([]);
    expect(await b.como(recep, () => b.filas('SELECT * FROM resumen_fallos_push()'))).toEqual([]);
    expect((await b.fila<{ an: boolean }>(`SELECT has_function_privilege('anon', 'resumen_fallos_push()', 'EXECUTE') AS an`)).an).toBe(false);
    const cols = await b.filas<{ c: string }>(`SELECT unnest(proargnames) AS c FROM pg_proc WHERE proname = 'resumen_fallos_push'`);
    expect(cols.map((x) => x.c)).toEqual(['tenant_id', 'desde', 'total', 'sin_config', 'tipos']);
  });

  it('24/30 · que el miembro lea el aviso (campana) no resuelve nada; el aviso y el hecho siguen intactos', async () => {
    const id = await aviso(miembro, 'fallo');
    await b.como(miembro, () => b.db.query('UPDATE notificaciones SET leida = true, leida_at = now() WHERE id = $1', [id]));
    expect((await pendientes(admin)).find((x) => x.fuente === 'notificaciones_push')?.detalle).toMatch(/^4 sin entregar/);
    // El cliente no puede marcar la revisión (frontera de avisos de 02C/03A).
    await expect(b.como(miembro, () => b.db.query('UPDATE notificaciones SET push_revisado_at = now() WHERE id = $1', [id]))).rejects.toThrow(/EKKO_AVISO_SOLO_LECTURA/);
  });

  it('26 · revisar exige admin y nota; marca todo lo pendiente del estudio con evidencia; lo nuevo vuelve a salir', async () => {
    await expect(b.como(recep, () => b.fila(`SELECT revisar_fallos_push('Revisado en Netlify')`))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(b.como(admin, () => b.fila(`SELECT revisar_fallos_push('corta')`))).rejects.toThrow(/EKKO_NOTA_REQUERIDA/);
    const r = await b.como(admin, () => b.fila<{ r: { revisados: number } }>(`SELECT revisar_fallos_push('Revisé la configuración VAPID') AS r`));
    expect(r.r).toMatchObject({ revisados: 4, idempotente: false });
    expect((await pendientes(admin)).filter((x) => x.fuente === 'notificaciones_push')).toEqual([]);
    expect(await b.fila<{ accion: string; actor_usuario_id: string }>(`SELECT accion, actor_usuario_id FROM audit_log WHERE accion = 'fallos_push_revisados'`))
      .toMatchObject({ actor_usuario_id: admin.id });
    expect((await b.como(admin, () => b.fila<{ r: { idempotente: boolean } }>(`SELECT revisar_fallos_push('Otra vez, nada nuevo') AS r`))).r.idempotente).toBe(true);
    await aviso(miembro, 'fallo');
    expect((await pendientes(admin)).find((x) => x.fuente === 'notificaciones_push')?.detalle).toMatch(/^1 sin entregar/);
  });

  it('10 · aislamiento: los fallos de otro estudio no se ven ni se revisan', async () => {
    const otro = (await b.fila<{ id: string }>(`INSERT INTO usuarios (tenant_id, email, rol, status) VALUES ($1, 'm-b-06g@test.mx', 'miembro', 'activo') RETURNING id`, [tenantB])).id;
    await b.db.query(`INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, push_resultado) VALUES ($1, $2, 'aviso_manual', 't', 'm', 'fallo')`, [tenantB, otro]);
    expect((await pendientes(admin)).find((x) => x.fuente === 'notificaciones_push')?.detalle).toMatch(/^1 sin entregar/);
    const enB = (await pendientes(adminB)).filter((x) => x.fuente === 'notificaciones_push');
    expect(enB).toHaveLength(1);
    expect(enB[0].tenant_id).toBe(tenantB);
  });
});

describe('Operación: quién ve qué', () => {
  it('27/28/29 · admin ve las ramas nuevas; recepción y miembro, nada (como todas las ramas de Operación)', async () => {
    await envejecer('cron-recordatorios', 'ultimo_exito_at', '3 hours');
    const tipos = (await pendientes(admin)).map((x) => x.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['proceso_atrasado', 'push_no_entregado']));
    expect(await pendientes(recep)).toEqual([]);
    expect(await pendientes(miembro)).toEqual([]);
    await sanos();
  });

  it('31 · las ramas previas siguen intactas y la vista sigue siendo security_invoker', async () => {
    const def = await b.fila<{ d: string; opt: string[] }>(
      `SELECT pg_get_viewdef('v_pendientes_operativos'::regclass) AS d, c.reloptions AS opt FROM pg_class c WHERE c.relname = 'v_pendientes_operativos'`);
    expect(def.opt).toContain('security_invoker=true');
    for (const fuente of ['revisiones_financieras', 'stripe_webhook_events', 'stripe_operaciones_suscripcion', 'correos_directos', 'v_reconciliacion_membresia', 'discrepancias_stripe']) {
      expect(def.d).toContain(fuente);
    }
    await b.db.exec('SET ROLE anon');
    try {
      await expect(b.db.query('SELECT * FROM v_pendientes_operativos')).rejects.toThrow(/permission denied/);
    } finally {
      await b.db.exec('RESET ROLE');
    }
  });
});
