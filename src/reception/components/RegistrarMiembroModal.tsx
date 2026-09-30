import { useEffect, useRef, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import {
  activarMembresiaMostrador,
  nuevaOperacionMostrador,
  montoCobradoMostrador,
  conflictoVentaMostrador,
  METODOS_MOSTRADOR,
  type MetodoMostrador
} from '@shared/lib/checkout';
import { CopyButton } from '@shared/components/CopyButton';
import { traducirErrorRegistro } from '../lib/traducirErrorRegistro';
import { usePlanesActivos } from '@shared/hooks/usePlanesActivos';
import { ErrorInline } from '@shared/components/ErrorCarga';

interface Props {
  onClose: () => void;
  /** Se llama al cerrar la vista de credenciales — el email queda
   *  pre-cargado en la búsqueda para ubicar al nuevo miembro. */
  onRegistrado: (email: string) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Alfabeto sin caracteres ambiguos (0/O, 1/l/I) — el recepcionista
// dicta esta contraseña al cliente. Mismo criterio que NuevaPersonaModal.
const PASSWORD_ALFABETO = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarPassword(): string {
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += PASSWORD_ALFABETO[Math.floor(Math.random() * PASSWORD_ALFABETO.length)];
  }
  return out;
}

/** PKG-01D: activación pendiente tras crear la cuenta; conserva el MISMO operation_id para reintentar. */
interface ActivacionPendiente {
  usuarioId: string;
  tier: string;
  metodo: MetodoMostrador;
  operationId: string;
}

interface MiembroCreado {
  nombre: string;
  email: string;
  password: string;
  plan: string;
  planNombre: string;
  /** true si se activó la membresía en el mismo registro (cobro en caja). */
  activada: boolean;
  /** Si la activación falló: datos para reintentarla con el mismo operation_id. */
  pendiente?: ActivacionPendiente;
}

/**
 * Registrar un miembro nuevo desde el mostrador (Sprint RP-4).
 *
 * Consume la Netlify Function `reception-create-member` (RP-1). Dos fases:
 * (1) formulario, (2) credenciales para el cliente. El rol lo fija la función
 * a 'miembro' (defensa en profundidad).
 *
 * Flujo híbrido: si se elige un PLAN INICIAL, tras crear la cuenta se activa la
 * membresía en el mismo paso (cobro en caja, RPC `activar_membresia`) → walk-in
 * en un solo paso. Sin plan, el miembro nace `pendiente_pago` y se activa luego
 * desde su perfil. Si la creación funciona pero la activación falla, la cuenta
 * queda creada (pendiente) y se avisa: nunca se pierde nada.
 *
 * PKG-01D: con plan, el método de pago es obligatorio y la activación lleva un
 * `operation_id` generado UNA vez al abrir el modal. Si la activación falla o
 * se agota el tiempo, "Reintentar activación" usa el MISMO id: el servidor
 * devuelve la venta ya registrada en vez de crear otra.
 */
export function RegistrarMiembroModal({ onClose, onRegistrado }: Props) {
  const toast = useToast();

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [telefono, setTelefono] = useState('');
  const [tier, setTier] = useState('');
  const [metodo, setMetodo] = useState<MetodoMostrador | ''>('');
  const { planes, error: errorPlanes, recargar: recargarPlanes } = usePlanesActivos();
  // Una intención de venta = un operation_id (no cambia por reintentos).
  const operationId = useRef(nuevaOperacionMostrador());
  const [reintentando, setReintentando] = useState(false);
  // Contraseña temporal autogenerada al montar (lazy init → estable).
  const [password, setPassword] = useState(() => generarPassword());
  const [submitting, setSubmitting] = useState(false);
  const [creado, setCreado] = useState<MiembroCreado | null>(null);

  // Escape cierra solo en la fase de formulario: en la fase "creado" el
  // recepcionista debe cerrar de forma explícita para no perder las
  // credenciales por accidente.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting && !creado) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting, creado]);

  const nombreValido = nombre.trim().length >= 2;
  const emailValido = EMAIL_REGEX.test(email.trim());
  const passwordValida = password.length >= 8;
  const canSubmit = nombreValido && emailValido && passwordValida && !submitting && (!tier || !!metodo);
  const planElegido = planes.find((p) => p.slug === tier) ?? null;
  const pesos = (c: number) => `$${Math.round(c / 100).toLocaleString('es-MX')}`;

  function mensajeActivacion(actErr: unknown): string {
    if (conflictoVentaMostrador(actErr) === 'suscripcion_stripe') return 'Cuenta creada, pero tiene una suscripción de Stripe vigente: resuélvela antes de vender en mostrador.';
    return actErr instanceof Error
      ? `Cuenta creada, pero no se pudo activar: ${actErr.message}. Puedes reintentar con la misma venta.`
      : 'Cuenta creada, pero no se pudo activar. Puedes reintentar con la misma venta.';
  }

  async function reintentarActivacion() {
    if (!creado?.pendiente || reintentando) return;
    setReintentando(true);
    try {
      const r = await activarMembresiaMostrador(creado.pendiente.usuarioId, creado.pendiente.tier, {
        operationId: creado.pendiente.operationId,
        metodo: creado.pendiente.metodo
      });
      if (!r?.success) throw new Error('No se pudo registrar la venta.');
      toast.success(r.idempotente ? 'La venta ya estaba registrada: membresía activa.' : 'Membresía activada.');
      setCreado({ ...creado, activada: true, pendiente: undefined });
    } catch (actErr) {
      toast.error(mensajeActivacion(actErr));
    } finally {
      setReintentando(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');
      }

      const emailNorm = email.trim().toLowerCase();
      const nombreNorm = nombre.trim();
      const telNorm = telefono.trim();

      // `fetch` crudo en lugar de `backendPost`: backendPost descarta el
      // body del error y deja solo el status, y aquí necesitamos
      // `result.error` para traducir "email duplicado" y demás. NO se
      // manda `rol` ni `tenant_id` — la función los fija (rol='miembro',
      // tenant del caller). Mandar más campos no escalaría: el handler
      // nunca los lee.
      const res = await fetch('/.netlify/functions/reception-create-member', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          nombre: nombreNorm,
          email: emailNorm,
          password,
          telefono: telNorm || undefined,
          membresia_tier: tier || undefined
        })
      });

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(traducirErrorRegistro((result?.error as string) || ''));
        setSubmitting(false);
        return;
      }

      // Flujo híbrido: si se eligió plan, activar la membresía en el mismo paso
      // (cobro en caja). Si la activación falla, la cuenta ya quedó creada
      // (pendiente) → se avisa en la vista de credenciales; nada se pierde.
      let activada = false;
      let pendiente: ActivacionPendiente | undefined;
      const nuevoId = (result?.user as { id?: string } | undefined)?.id;
      if (tier && metodo && nuevoId) {
        try {
          const r = await activarMembresiaMostrador(nuevoId, tier, { operationId: operationId.current, metodo });
          activada = r?.success === true; // éxito solo con confirmación del servidor
          if (!activada) pendiente = { usuarioId: nuevoId, tier, metodo, operationId: operationId.current };
        } catch (actErr) {
          pendiente = { usuarioId: nuevoId, tier, metodo, operationId: operationId.current };
          toast.error(mensajeActivacion(actErr));
        }
      }

      setCreado({
        nombre: nombreNorm,
        email: emailNorm,
        password,
        plan: tier,
        planNombre: planes.find((p) => p.slug === tier)?.nombre ?? tier,
        activada,
        pendiente
      });
    } catch (err) {
      toast.error(traducirErrorRegistro(err instanceof Error ? err.message : ''));
      setSubmitting(false);
    }
  }

  return (
    // Solo cierra con el botón ✕: es un alta con varios datos, un clic fuera no
    // debe perderlos.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Registrar miembro"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--ek-backdrop)',
        backdropFilter: 'blur(var(--ek-backdrop-blur))',
        WebkitBackdropFilter: 'blur(var(--ek-backdrop-blur))',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '480px',
          width: '100%',
          maxHeight: '92dvh',
          overflowY: 'auto',
          padding: 'clamp(16px, 5vw, 28px)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        {creado ? (
          <CredencialesView
            creado={creado}
            onCerrar={() => onRegistrado(creado.email)}
            onReintentar={creado.pendiente ? reintentarActivacion : undefined}
            reintentando={reintentando}
          />
        ) : (
          <form onSubmit={handleSubmit}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>
              REGISTRAR MIEMBRO
            </p>
            <h3
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 700,
                margin: 0,
                marginBottom: '16px',
                letterSpacing: '-0.02em'
              }}
            >
              Nuevo miembro
            </h3>

            <div className="ek-form-field" style={{ marginBottom: '14px' }}>
              <label className="ek-label" htmlFor="rm-nombre">
                Nombre completo
              </label>
              <input
                id="rm-nombre"
                type="text"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="ek-input"
                placeholder="Ana López"
                required
                minLength={2}
                disabled={submitting}
                autoComplete="name"
              />
            </div>

            <div className="ek-form-field" style={{ marginBottom: '14px' }}>
              <label className="ek-label" htmlFor="rm-email">
                Email
              </label>
              <input
                id="rm-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="ek-input"
                placeholder="ana@correo.com"
                required
                disabled={submitting}
                autoComplete="email"
                inputMode="email"
              />
            </div>

            <div className="ek-form-field" style={{ marginBottom: '14px' }}>
              <label className="ek-label" htmlFor="rm-telefono">
                Teléfono <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span>
              </label>
              <input
                id="rm-telefono"
                type="tel"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="ek-input"
                placeholder="667 123 4567"
                disabled={submitting}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>

            <div className="ek-form-field" style={{ marginBottom: '14px' }}>
              <label className="ek-label" htmlFor="rm-plan">
                Plan inicial <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span>
              </label>
              <select
                id="rm-plan"
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                className="ek-input"
                disabled={submitting || errorPlanes}
              >
                <option value="">{errorPlanes ? '— planes no disponibles —' : '— Sin plan (activar después) —'}</option>
                {!errorPlanes && planes.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.nombre}</option>
                ))}
              </select>
              {/* PKG-02A (F12): fallo al leer los planes ≠ "no hay planes". */}
              {errorPlanes && (
                <div style={{ marginTop: '8px' }}>
                  <ErrorInline mensaje="No pudimos cargar los planes. Puedes registrar sin plan y activarlo después, o reintentar." onReintentar={recargarPlanes} />
                </div>
              )}
              {tier && (
                <div role="radiogroup" aria-label="Cómo pagó" style={{ marginTop: '10px' }}>
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
                        <input type="radio" name="rm-metodo" value={m.valor} checked={metodo === m.valor} onChange={() => setMetodo(m.valor)} disabled={submitting} />
                        {m.label}
                      </label>
                    ))}
                  </div>
                  {planElegido && typeof planElegido.precio_centavos === 'number' && metodo && (
                    <p data-testid="resumen-cobro" style={{ fontSize: '12px', margin: '8px 0 0', lineHeight: 1.45 }}>
                      {metodo === 'cortesia'
                        ? <><strong>$0 cobrado</strong> · cortesía. Precio de lista {pesos(planElegido.precio_centavos)}.</>
                        : <><strong>{pesos(montoCobradoMostrador(planElegido.precio_centavos, metodo))} cobrado</strong> · precio de lista {pesos(planElegido.precio_centavos)}.</>}
                    </p>
                  )}
                </div>
              )}
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
                {tier
                  ? 'Se activa la membresía al registrar (confirmas el cobro en caja). La venta queda registrada con importe y método.'
                  : 'Sin plan queda pendiente de pago; lo activas luego desde su perfil.'}
              </p>
            </div>

            <div className="ek-form-field" style={{ marginBottom: '8px' }}>
              <label className="ek-label" htmlFor="rm-password">
                Contraseña temporal
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  id="rm-password"
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="ek-input"
                  placeholder="Mínimo 8 caracteres"
                  required
                  minLength={8}
                  disabled={submitting}
                  autoComplete="off"
                  style={{ flex: 1, fontFamily: 'var(--ek-font-mono)' }}
                />
                <button
                  type="button"
                  onClick={() => setPassword(generarPassword())}
                  disabled={submitting}
                  className="ek-icon-btn"
                  aria-label="Generar otra contraseña"
                  style={{
                    width: '44px',
                    minHeight: '44px',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </button>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
                Autogenerada y temporal. Se la das al cliente; al entrar la app le pedirá cambiarla por una suya.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1, minHeight: '44px' }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="ek-cta ek-cta--gold"
                style={{ flex: 1, minHeight: '44px', opacity: canSubmit ? 1 : 0.5 }}
              >
                {submitting ? 'Registrando…' : tier ? 'Registrar y activar' : 'Registrar miembro'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function CredencialesView({
  creado,
  onCerrar,
  onReintentar,
  reintentando
}: {
  creado: MiembroCreado;
  onCerrar: () => void;
  onReintentar?: () => void;
  reintentando?: boolean;
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const credencialesTexto = [
    'EKKO Studio — Tu acceso',
    '',
    `Nombre: ${creado.nombre}`,
    `Email: ${creado.email}`,
    `Contraseña: ${creado.password}`,
    '',
    `Inicia sesión en: ${origin}/login`
  ].join('\n');

  return (
    <>
      <p
        className="ek-eyebrow"
        style={{
          marginBottom: '6px',
          color: 'var(--ek-success)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px'
        }}
      >
        <CheckCircle2 size={13} aria-hidden="true" />
        MIEMBRO REGISTRADO
      </p>
      <h3
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '20px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          margin: 0,
          marginBottom: '8px'
        }}
      >
        Entrega estas credenciales a {creado.nombre}
      </h3>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '16px' }}>
        Compártelas verbalmente o por WhatsApp. El cliente las usa para entrar a EKKO.
      </p>

      <div
        style={{
          background: 'var(--ek-bg-elevated)',
          border: '0.5px solid var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-md)',
          padding: '16px 18px',
          marginBottom: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}
      >
        <CredField label="Nombre" value={creado.nombre} />
        <CredField label="Email" value={creado.email} mono />
        <CredField label="Contraseña" value={creado.password} mono />
      </div>

      <div style={{ marginBottom: '14px' }}>
        <CopyButton
          text={credencialesTexto}
          label="Copiar credenciales"
          copiedLabel="Copiado"
          full
        />
      </div>

      {creado.activada ? (
        <div
          role="status"
          style={{
            fontSize: '12px',
            color: 'var(--ek-success)',
            background: 'var(--ek-success-soft)',
            padding: '12px 14px',
            borderRadius: 'var(--ek-r-sm)',
            margin: '0 0 20px',
            lineHeight: 1.55,
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}
        >
          <CheckCircle2 size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            Membresía <strong>{creado.planNombre}</strong> activa — ya puede reservar.
          </span>
        </div>
      ) : (
        <div
          role="alert"
          style={{
            fontSize: '12px',
            color: 'var(--ek-mustard)',
            background: 'var(--ek-mustard-soft)',
            padding: '12px 14px',
            borderRadius: 'var(--ek-r-sm)',
            margin: '0 0 20px',
            lineHeight: 1.55,
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}
        >
          <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            La cuenta queda <strong>PENDIENTE DE ACTIVACIÓN</strong> — asignas plan y activas desde su
            perfil (cobro en caja). Mientras tanto el miembro no podrá reservar.
            {onReintentar && (
              <>
                {' '}Si ya cobraste, reintenta aquí: usa la misma venta y no se registra dos veces.
                <button
                  type="button"
                  className="ek-cta ek-cta--gold"
                  style={{ display: 'block', marginTop: '8px', padding: '8px 12px', fontSize: '13px' }}
                  onClick={onReintentar}
                  disabled={reintentando}
                >
                  {reintentando ? 'Reintentando…' : 'Reintentar activación'}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={onCerrar}
        className="ek-cta ek-cta--secondary ek-cta--full"
        style={{ padding: '12px', fontSize: '14px', minHeight: '44px' }}
      >
        Listo
      </button>
    </>
  );
}

function CredField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'baseline' }}>
      <span
        style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          letterSpacing: '0.08em',
          fontWeight: 700,
          textTransform: 'uppercase',
          minWidth: '84px'
        }}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: '14px',
          color: 'var(--ek-ink)',
          fontFamily: mono ? 'var(--ek-font-mono)' : 'inherit',
          userSelect: 'all',
          wordBreak: 'break-all'
        }}
      >
        {value}
      </span>
    </div>
  );
}
