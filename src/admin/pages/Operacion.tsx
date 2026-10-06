import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { ErrorCarga } from '@shared/components/ErrorCarga';
import { formatFechaHoraEnZona } from '@shared/lib/timezone';
import { LABEL_TIPO_REVISION } from '../hooks/useRevisionesFinancieras';
import { useOperacion, type PendienteOperativo, type ResolucionEvento } from '../hooks/useOperacion';

/**
 * PKG-03A · Operación — el trabajo que el sistema detectó y que necesita una
 * decisión humana. Cada fila viene de su autoridad (no hay copia ni lista de
 * tareas genérica) y se resuelve con la RPC de su dominio, con nota. Lo que NO
 * hace: reenviar correos, reparar cobros en Stripe, mover créditos o membresías.
 */

const TITULO_DOMINIO: Record<string, string> = {
  finanzas: 'Revisiones financieras',
  stripe: 'Eventos de Stripe sin resolver',
  cobro: 'Cambios de cobro en Stripe',
  entrega: 'Avisos que no se entregaron',
  membresia: 'Membresías inconsistentes',
  // PKG-06G
  procesos: 'Procesos automáticos'
};
const ORDEN_DOMINIO = ['procesos', 'cobro', 'stripe', 'finanzas', 'membresia', 'entrega'];

const LABEL_TIPO: Record<string, string> = {
  ...LABEL_TIPO_REVISION,
  evento_revision: 'Evento que Stripe ya no reintenta',
  evento_error_reintentable: 'Evento con error (Stripe reintentando)',
  evento_en_proceso: 'Evento a medio procesar',
  suspender_cobro: 'Suspender cobro (sanción)',
  reanudar_cobro: 'Reanudar cobro',
  cancelar_suscripcion: 'Cancelar suscripción',
  cancelar_fin_periodo: 'Programar cancelación al fin del periodo',
  correo_aviso_fallido: 'Correo de aviso',
  correo_directo_fallido: 'Correo de cobro',
  activo_sin_derecho: 'Acceso activo sin membresía vigente',
  activa_id_invalido: 'Puntero de membresía inválido',
  membresia_vencida_sin_expirar: 'Membresía vencida sin expirar',
  varias_membresias_vivas: 'Varias membresías vivas',
  stripe_contradictorio: 'Stripe contradijo el estado',
  stripe_customer_distinto: 'Cliente de Stripe distinto',
  // PKG-03B · lo que EKKO espera ≠ lo que Stripe contiene
  discrepancia_suscripcion_ausente: 'Stripe no tiene la suscripción que EKKO espera',
  discrepancia_suscripcion_huerfana: 'Suscripción viva en Stripe que EKKO no respalda',
  discrepancia_estado_distinto: 'Membresía viva en EKKO, terminada en Stripe',
  discrepancia_pausa_distinta: 'La pausa del cobro no coincide',
  discrepancia_cancelacion_distinta: 'La cancelación al fin del periodo no coincide',
  discrepancia_plan_distinto: 'El plan en Stripe no es el de la membresía',
  reconciliacion_parcial: 'La última reconciliación con Stripe quedó incompleta',
  reconciliacion_fallida: 'La última reconciliación con Stripe falló',
  // PKG-06G · señales durables sin Sentry
  reconciliacion_atrasada: 'La reconciliación diaria con Stripe no ha corrido',
  proceso_atrasado: 'Un proceso automático no ha corrido a tiempo',
  proceso_fallando: 'Un proceso automático está fallando',
  push_no_entregado: 'Avisos push que no llegaron al teléfono'
};

const LABEL_ACCION: Record<string, string> = {
  decidir_operacion: 'Stripe no la aplicó tras varios intentos: decide si reintentar o descartar.',
  vigilar_operacion: 'Se está reintentando sola. Puedes descartarla si ya lo resolviste en Stripe.',
  resolver_evento: 'Revisa el evento en el panel de Stripe y deja la resolución.',
  atender_fallo_entrega: 'Avísale por otro medio si hace falta y márcalo como atendido.',
  resolver_revision: 'Se resuelve en Cobros.',
  revisar_miembro: 'Revisa su ficha.',
  revisar_discrepancia: 'Revisa en el panel de Stripe y en la ficha. EKKO no corrige nada solo: se cierra cuando ambos coinciden.',
  discrepancia_revisada: 'Ya revisada; sigue abierta porque Stripe y EKKO aún no coinciden.',
  reconciliacion_incompleta: 'No se leyó todo Stripe: lo no visto no se dio por bueno ni por malo. Se reintentará.',
  reconciliacion_atrasada: 'Revisa en Netlify que la función programada cron-reconciliar-stripe siga activa y sin errores. Desaparece sola cuando vuelva a correr.',
  revisar_proceso: 'Revisa en Netlify (Functions → la función programada) que esté activa y sus registros. EKKO no lo corre ni lo repara solo; desaparece cuando vuelva a correr bien.',
  revisar_fallos_push: 'Lo que se avisó SÍ ocurrió y el aviso sigue en la campana de la app: solo no llegó como notificación al teléfono. Si se repite, revisa la configuración de push. Márcalo como revisado.'
};

type Accion = 'evento' | 'reintentar' | 'descartar' | 'entrega' | 'revisar' | 'push';

export default function Operacion() {
  const { pendientes, error, refetch, resolverEvento, reintentarOperacion, descartarOperacion, atenderFalloEntrega, revisarDiscrepancia, revisarFallosPush } = useOperacion();
  const [abierto, setAbierto] = useState<{ key: string; accion: Accion } | null>(null);
  const [nota, setNota] = useState('');
  const [resolucion, setResolucion] = useState<ResolucionEvento>('reenviado_desde_stripe');
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const clave = (p: PendienteOperativo) => `${p.fuente}:${p.fuente_id}:${p.tipo}`;

  function abrir(p: PendienteOperativo, accion: Accion) {
    setAbierto({ key: clave(p), accion });
    setNota('');
    setMensaje(null);
    setHecho(null);
  }

  async function guardar(p: PendienteOperativo, accion: Accion) {
    setGuardando(true);
    setMensaje(null);
    const r =
      accion === 'evento' ? await resolverEvento(p.fuente_id, resolucion, nota)
      : accion === 'reintentar' ? await reintentarOperacion(p.fuente_id, nota)
      : accion === 'descartar' ? await descartarOperacion(p.fuente_id, nota)
      : accion === 'revisar' ? await revisarDiscrepancia(p.fuente_id, nota)
      : accion === 'push' ? await revisarFallosPush(nota)
      : await atenderFalloEntrega(p.fuente, p.fuente_id, nota);
    setGuardando(false);
    if (r.error) {
      setMensaje(r.error);
      return;
    }
    setAbierto(null);
    setHecho(accion === 'reintentar'
      ? 'Listo: se reintentará en la próxima sincronización de cobros.'
      : accion === 'revisar'
        ? 'Listo: quedó tu nota. La diferencia sigue abierta hasta que Stripe y EKKO coincidan.'
        : 'Listo: quedó registrado con tu nota.');
  }

  if (pendientes === null) return <div className="ek-card"><Spinner label="Cargando pendientes…" /></div>;

  const porDominio = ORDEN_DOMINIO
    .map((d) => [d, pendientes.filter((p) => p.dominio === d)] as const)
    .filter(([, lista]) => lista.length > 0);

  return (
    <div data-testid="operacion">
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>OPERACIÓN</p>
      <h1 className="ek-h2" style={{ marginBottom: '6px' }}>Pendientes operativos</h1>
      <p className="ek-body-muted" style={{ marginBottom: '20px' }}>
        Lo que el sistema detectó y necesita una decisión tuya. Marcar un aviso como leído no lo resuelve: se resuelve aquí, con una nota.
      </p>

      {error && <ErrorCarga titulo="No se pudieron cargar los pendientes operativos." onReintentar={() => void refetch()} />}
      {hecho && <p role="status" style={{ color: 'var(--ek-success)', fontSize: '13.5px', margin: '0 0 12px' }}>{hecho}</p>}

      {!error && porDominio.length === 0 && (
        <div className="ek-card" style={{ display: 'flex', gap: '10px', alignItems: 'center' }} data-testid="operacion-vacia">
          <CheckCircle2 size={18} style={{ color: 'var(--ek-success)' }} aria-hidden="true" />
          <span>Nada pendiente.</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {porDominio.map(([dominio, lista]) => (
          <section key={dominio} className="ek-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid={`dominio-${dominio}`}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
              {(TITULO_DOMINIO[dominio] ?? dominio).toUpperCase()} · {lista.length}
            </p>
            {lista.map((p) => {
              const k = clave(p);
              const accionAbierta = abierto?.key === k ? abierto.accion : null;
              return (
                <div key={k} style={{ borderTop: '1px solid var(--ek-line)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }} data-testid="pendiente">
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <AlertTriangle size={16} aria-hidden="true"
                      style={{ color: p.severidad === 'alta' ? 'var(--ek-danger)' : 'var(--ek-warning)', flexShrink: 0, marginTop: '2px' }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>{LABEL_TIPO[p.tipo] ?? p.tipo}</p>
                      <p className="ek-body-muted" style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
                        {p.desde ? formatFechaHoraEnZona(p.desde, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Detectado ahora'}
                        {p.detalle ? <> · <span style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '12px' }}>{p.detalle}</span></> : null}
                      </p>
                      <p style={{ margin: '4px 0 0', fontSize: '13px' }}>
                        {LABEL_ACCION[p.accion] ?? ''}
                        {p.usuario_id && p.ruta !== `/admin/miembros/${p.usuario_id}` && (
                          <> <Link to={`/admin/miembros/${p.usuario_id}`} style={{ color: 'var(--ek-mustard)' }}>Ver miembro</Link></>
                        )}
                      </p>
                    </div>
                  </div>

                  {accionAbierta ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '24px' }}>
                      {accionAbierta === 'evento' && (
                        <>
                          <label className="ek-label" htmlFor={`res-${k}`}>Resolución</label>
                          <select id={`res-${k}`} className="ek-input" value={resolucion} onChange={(e) => setResolucion(e.target.value as ResolucionEvento)}>
                            <option value="reenviado_desde_stripe">Lo reenvié desde el panel de Stripe</option>
                            <option value="sin_efecto">Revisado, no requiere nada</option>
                            <option value="ajuste_manual_registrado">Ajusté a mano en EKKO (lo dejo registrado)</option>
                            <option value="otro">Otro</option>
                          </select>
                        </>
                      )}
                      {accionAbierta === 'descartar' && (
                        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ek-warning)' }}>
                          EKKO dejará de intentarlo. Si Stripe sigue cobrando o sin suspender, tendrás que resolverlo en su panel.
                        </p>
                      )}
                      <label className="ek-label" htmlFor={`nota-${k}`}>Nota (obligatoria)</label>
                      <textarea id={`nota-${k}`} className="ek-input" rows={2} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Qué revisaste y qué decidiste" />
                      {mensaje && <p className="ek-error-text" style={{ margin: 0 }}>{mensaje}</p>}
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button type="button" className="ek-cta ek-cta--gold" onClick={() => void guardar(p, accionAbierta)} disabled={guardando || nota.trim().length < 10}>
                          {guardando ? <Spinner size={14} /> : 'Guardar'}
                        </button>
                        <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setAbierto(null)} disabled={guardando}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ paddingLeft: '24px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {p.fuente === 'stripe_webhook_events' && (
                        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'evento')}>Resolver</button>
                      )}
                      {p.fuente === 'stripe_operaciones_suscripcion' && (
                        <>
                          {p.accion === 'decidir_operacion' && (
                            <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'reintentar')}>Reintentar</button>
                          )}
                          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'descartar')}>Descartar</button>
                        </>
                      )}
                      {p.fuente === 'discrepancias_stripe' && p.accion === 'revisar_discrepancia' && (
                        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'revisar')}>Marcar como revisada</button>
                      )}
                      {p.fuente === 'notificaciones_push' && (
                        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'push')}>Marcar como revisado</button>
                      )}
                      {(p.fuente === 'notificaciones' || p.fuente === 'correos_directos') && (
                        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => abrir(p, 'entrega')}>Marcar como atendido</button>
                      )}
                      {(p.fuente === 'revisiones_financieras' || p.fuente === 'v_reconciliacion_membresia') && (
                        <Link to={p.ruta} className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }}>
                          {p.fuente === 'revisiones_financieras' ? 'Ir a Cobros' : 'Ver ficha'}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
