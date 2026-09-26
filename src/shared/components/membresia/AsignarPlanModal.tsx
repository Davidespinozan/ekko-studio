import { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { activarMembresiaMostrador, esPerdidaDeCreditos } from '@shared/lib/checkout';
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
 */
export function AsignarPlanModal({ usuarioId, nombre, modo, planActualSlug, onClose, onDone }: Props) {
  const toast = useToast();
  const [planes, setPlanes] = useState<Plan[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [elegido, setElegido] = useState<string>(modo === 'renovar' ? planActualSlug ?? '' : '');
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);
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
    if (motivo.trim().length < 3) {
      toast.error('Indica cómo pagó o por qué se asigna (mínimo 3 caracteres).');
      return;
    }
    setGuardando(true);
    try {
      await activarMembresiaMostrador(usuarioId, elegido, {
        confirmarPerdida: creditosEnJuego !== null,
        motivo: motivo.trim()
      });
      toast.success(modo === 'renovar' ? 'Plan renovado.' : 'Plan activado.');
      await onDone();
      onClose();
    } catch (e) {
      const enJuego = esPerdidaDeCreditos(e);
      if (enJuego !== null && creditosEnJuego === null) {
        setCreditosEnJuego(enJuego); // el siguiente Confirmar ya lleva la confirmación
      } else {
        toast.error(e instanceof Error ? e.message : 'No se pudo activar el plan.');
      }
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalAccion
      titulo={TITULO[modo]}
      icono={<BadgeCheck size={14} aria-hidden="true" />}
      sujeto={nombre ?? 'Miembro'}
      confirmarLabel={creditosEnJuego !== null ? 'Sí, cambiar y perder créditos' : modo === 'renovar' ? 'Renovar' : 'Activar plan'}
      peligro={creditosEnJuego !== null}
      guardando={guardando}
      bloqueado={!elegido}
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
                      <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ek-ink-faint)' }}> · plan actual</span>
                    )}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)' }}>{describir(p)}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <label className="ek-label" style={{ display: 'block', marginTop: '14px' }}>
        Cómo pagó / motivo
        <input
          className="ek-input"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Ej. Transferencia confirmada · Cortesía del dueño"
          maxLength={200}
        />
      </label>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '6px 0 0', lineHeight: 1.45 }}>
        Esto activa el plan SIN cobrar por Stripe: confirma antes que el pago ya entró. Queda registrado con tu nombre.
      </p>

      {creditosEnJuego !== null && (
        <p role="alert" style={{ fontSize: '13px', lineHeight: 1.45, margin: '12px 0 0', padding: '10px 12px', borderRadius: 'var(--ek-r-sm)', border: '1px solid var(--ek-danger)', background: 'rgba(226,85,85,0.10)' }}>
          Le quedan <strong>{creditosEnJuego} {creditosEnJuego === 1 ? 'crédito' : 'créditos'}</strong> y el plan elegido no usa créditos: <strong>se perderán</strong>. Vuelve a confirmar solo si el miembro está de acuerdo.
        </p>
      )}
    </ModalAccion>
  );
}
