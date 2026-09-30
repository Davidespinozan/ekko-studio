import { useEffect, useRef, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import {
  activarMembresiaMostrador,
  esPerdidaDeCreditos,
  conflictoVentaMostrador,
  nuevaOperacionMostrador,
  montoCobradoMostrador,
  METODOS_MOSTRADOR,
  type MetodoMostrador
} from '@shared/lib/checkout';
import { esPaqueteDeCreditos } from '@shared/lib/membresiaEstado';
import { ModalAccion } from './ModalAccion';

interface Plan {
  slug: string;
  nombre: string;
  tipo: string | null;
  precio_centavos: number;
  clases_incluidas: number | null;
  duracion_dias: number | null;
}

interface Props {
  usuarioId: string;
  nombre: string | null;
  /** 'asignar' (sin plan) · 'renovar' (mismo plan otra vez) · 'cambiar'. Solo cambia textos y el plan preseleccionado. */
  modo: 'asignar' | 'renovar' | 'cambiar';
  /** Plan actual del miembro (para preseleccionarlo al renovar y marcarlo al cambiar). */
  planActualSlug?: string | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

const TITULO = { asignar: 'ASIGNAR PLAN', renovar: 'RENOVAR PLAN', cambiar: 'CAMBIAR PLAN' } as const;

function describir(p: Plan): string {
  const precio = `$${Math.round(p.precio_centavos / 100).toLocaleString('es-MX')}`;
  if (esPaqueteDeCreditos(p.tipo)) {
    const n = p.clases_incluidas ?? 0;
    const vig = p.duracion_dias ? ` · ${p.duracion_dias} días` : ' · no caducan';
    return `${precio} · ${n} ${n === 1 ? 'crédito' : 'créditos'}${vig}`;
  }
  return `${precio} · mensual, acceso ilimitado`;
}

/**
 * Asignar / renovar / cambiar el plan de un miembro EN UN PASO, desde mostrador o
 * admin. Antes había que ir a "Editar datos", elegir el plan, guardar con motivo,
 * volver y pulsar "Activar membresía" — y ese botón solo aparecía si la CUENTA no
 * estaba activa, así que a quien se le acababa el paquete no se le podía renovar.
 *
 * Pasa por el RPC keystone `activar_membresia` (vía reception-activar-membresia):
 * el mismo punto de activación que el webhook. Si el cambio quema créditos, el
 * SERVIDOR responde 409 y aquí se pide la confirmación explícita.
 *
 * PKG-01D: la venta lleva MÉTODO obligatorio (efectivo/transferencia/terminal/
 * cortesía) y un `operation_id` generado UNA vez al abrir el modal, que se
 * reutiliza en cada reintento (error, timeout, confirmación de pérdida): el
 * servidor registra UNA sola venta y UNA activación. El importe lo deriva el
 * servidor del catálogo; aquí solo se muestra (cortesía = $0 cobrado, con el
 * precio de lista visible). La nota deja de ser evidencia.
 */
export function AsignarPlanModal({ usuarioId, nombre, modo, planActualSlug, onClose, onDone }: Props) {
  const toast = useToast();
  const [planes, setPlanes] = useState<Plan[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [elegido, setElegido] = useState<string>(modo === 'renovar' ? planActualSlug ?? '' : '');
  const [metodo, setMetodo] = useState<MetodoMostrador | ''>('');
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);
  // Una intención = un operation_id. Reabrir el modal es otra intención.
  const operationId = useRef(nuevaOperacionMostrador());
  const [creditosEnJuego, setCreditosEnJuego] = useState<number | null>(null);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, tipo, precio_centavos, clases_incluidas, duracion_dias')
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (!vivo) return;
      if (error) {
        setErrorCarga(true);
        return;
      }
      setPlanes((data ?? []) as Plan[]);
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function confirmar() {
    if (!elegido) return;
    if (!metodo) {
      toast.error('Indica cómo pagó (efectivo, transferencia, terminal o cortesía).');
      return;
    }
    setGuardando(true);
    try {
      // El éxito solo se afirma cuando el servidor confirma la venta registrada.
      const r = await activarMembresiaMostrador(usuarioId, elegido, {
        operationId: operationId.current,
        metodo,
        confirmarPerdida: creditosEnJuego !== null,
        nota: nota.trim() || undefined
      });
      if (!r?.success) throw new Error('No se pudo registrar la venta.');
      const cobrado = r.venta?.monto_cobrado_centavos;
      toast.success(
        r.idempotente
          ? 'Esta venta ya estaba registrada; no se cobró ni activó dos veces.'
          : `${modo === 'renovar' ? 'Plan renovado' : 'Plan activado'} · ${metodo === 'cortesia' ? 'cortesía, $0 cobrado' : `$${Math.round((cobrado ?? 0) / 100).toLocaleString('es-MX')} en ${METODOS_MOSTRADOR.find((m) => m.valor === metodo)?.label.toLowerCase() ?? metodo}`}.`
      );
      await onDone();
      onClose();
    } catch (e) {
      const enJuego = esPerdidaDeCreditos(e);
      if (enJuego !== null && creditosEnJuego === null) {
        setCreditosEnJuego(enJuego); // el siguiente Confirmar ya lleva la confirmación (mismo operation_id)
      } else if (conflictoVentaMostrador(e) === 'suscripcion_stripe') {
        toast.error('Este miembro tiene una suscripción de Stripe vigente. Cancélala primero desde su membresía; el mostrador no la sustituye.', 10_000);
      } else if (conflictoVentaMostrador(e) === 'operacion_conflicto') {
        toast.error('Esta operación ya se registró con otros datos. Cierra el modal y vuelve a abrirlo para una venta nueva.', 10_000);
      } else {
        toast.error(e instanceof Error ? e.message : 'No se pudo activar el plan.');
      }
    } finally {
      setGuardando(false);
    }
  }

  const plan = planes?.find((p) => p.slug === elegido) ?? null;
  const pesos = (c: number) => `$${Math.round(c / 100).toLocaleString('es-MX')}`;

  return (
    <ModalAccion
      titulo={TITULO[modo]}
      icono={<BadgeCheck size={14} aria-hidden="true" />}
      sujeto={nombre ?? 'Miembro'}
      confirmarLabel={creditosEnJuego !== null ? 'Sí, cambiar y perder créditos' : modo === 'renovar' ? 'Renovar' : 'Activar plan'}
      peligro={creditosEnJuego !== null}
      guardando={guardando}
      bloqueado={!elegido || !metodo}
      onSubmit={confirmar}
      onClose={onClose}
    >
      {errorCarga ? (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--ek-danger)' }}>
          No se pudieron cargar los planes. Cierra e inténtalo de nuevo.
        </p>
      ) : planes === null ? (
        <div className="ek-skeleton" style={{ height: '120px', borderRadius: 'var(--ek-r-sm)' }} />
      ) : planes.length === 0 ? (
        <p className="ek-body-muted" style={{ fontSize: '13px' }}>
          El estudio no tiene planes activos. Créalos en Admin → Planes.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Plan" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {planes.map((p) => {
            const activo = elegido === p.slug;
            return (
              <label
                key={p.slug}
                style={{
                  display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', padding: '10px 12px',
                  borderRadius: 'var(--ek-r-sm)',
                  border: `1px solid ${activo ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                  background: activo ? 'var(--ek-mustard-soft)' : 'transparent'
                }}
              >
                <input
                  type="radio"
                  name="plan"
                  value={p.slug}
                  checked={activo}
                  // PKG-02B (C28): en "Cambiar plan" el plan actual no es un cambio; se
                  // ofrece desde "Renovar". Solo representación: el RPC no cambia.
                  disabled={modo === 'cambiar' && p.slug === planActualSlug}
                  onChange={() => {
                    setElegido(p.slug);
                    setCreditosEnJuego(null); // otro plan: la confirmación anterior ya no vale
                  }}
                  style={{ marginTop: '3px' }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600 }}>
                    {p.nombre}
                    {p.slug === planActualSlug && (
                      <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ek-ink-faint)' }}>
                        {modo === 'cambiar' ? ' · plan actual (para repetirlo usa Renovar)' : ' · plan actual'}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)' }}>{describir(p)}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div role="radiogroup" aria-label="Cómo pagó" style={{ marginTop: '14px' }}>
        <span className="ek-label" style={{ display: 'block', marginBottom: '6px' }}>Cómo pagó</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {METODOS_MOSTRADOR.map((m) => (
            <label
              key={m.valor}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '6px 10px', fontSize: '13px',
                borderRadius: 'var(--ek-r-sm)', border: `1px solid ${metodo === m.valor ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                background: metodo === m.valor ? 'var(--ek-mustard-soft)' : 'transparent'
              }}
            >
              <input type="radio" name="metodo" value={m.valor} checked={metodo === m.valor} onChange={() => setMetodo(m.valor)} />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      {plan && metodo && (
        // Lo que registrará el servidor (él deriva el importe del catálogo; esto solo lo muestra).
        <p data-testid="resumen-cobro" style={{ fontSize: '13px', margin: '10px 0 0', lineHeight: 1.45 }}>
          {metodo === 'cortesia' ? (
            <>
              <strong>$0 cobrado</strong> · cortesía. Precio de lista {pesos(plan.precio_centavos)}: queda registrado como no cobrado.
            </>
          ) : (
            <>
              <strong>{pesos(montoCobradoMostrador(plan.precio_centavos, metodo))} cobrado</strong> · precio de lista {pesos(plan.precio_centavos)}.
            </>
          )}
        </p>
      )}

      <label className="ek-label" style={{ display: 'block', marginTop: '12px' }}>
        Nota <span style={{ color: 'var(--ek-ink-faint)', fontWeight: 400 }}>(opcional: folio, quién autorizó…)</span>
        <input
          className="ek-input"
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Ej. Folio 8841 · Autorizó el dueño"
          maxLength={200}
        />
      </label>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '6px 0 0', lineHeight: 1.45 }}>
        Esto activa el plan SIN cobrar por Stripe: confirma antes que el pago ya entró. La venta queda registrada con importe, método y tu nombre.
      </p>

      {creditosEnJuego !== null && (
        <p role="alert" style={{ fontSize: '13px', lineHeight: 1.45, margin: '12px 0 0', padding: '10px 12px', borderRadius: 'var(--ek-r-sm)', border: '1px solid var(--ek-danger)', background: 'rgba(226,85,85,0.10)' }}>
          Le quedan <strong>{creditosEnJuego} {creditosEnJuego === 1 ? 'crédito' : 'créditos'}</strong> y el plan elegido no usa créditos: <strong>se perderán</strong>. Vuelve a confirmar solo si el miembro está de acuerdo.
        </p>
      )}
    </ModalAccion>
  );
}
