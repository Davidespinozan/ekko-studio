import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { traducirErrorRegistro } from '../lib/traducirErrorRegistro';

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

interface MiembroCreado {
  nombre: string;
  email: string;
  password: string;
}

/**
 * Registrar un miembro nuevo desde el mostrador (Sprint RP-4).
 *
 * Consume la Netlify Function `reception-create-member` (RP-1). El modal
 * tiene dos fases: (1) formulario de datos básicos, (2) credenciales para
 * entregar al cliente. NO hay campo de rol — la función lo fija a
 * 'miembro' (defensa en profundidad: la UI tampoco lo expone). NO se
 * asigna tier ni cobro: el miembro nace `pendiente_pago` y la activación
 * es responsabilidad de administración/Stripe (fuera de scope).
 */
export function RegistrarMiembroModal({ onClose, onRegistrado }: Props) {
  const toast = useToast();

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [telefono, setTelefono] = useState('');
  // Contraseña temporal autogenerada al montar (lazy init → estable).
  const [password, setPassword] = useState(() => generarPassword());
  const [submitting, setSubmitting] = useState(false);
  const [creado, setCreado] = useState<MiembroCreado | null>(null);
  const [copiado, setCopiado] = useState(false);

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
  const canSubmit = nombreValido && emailValido && passwordValida && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Tu sesión expiró. Iniciá sesión de nuevo.');
      }

      const emailNorm = email.trim().toLowerCase();
      const nombreNorm = nombre.trim();
      const telNorm = telefono.trim();

      // `fetch` crudo en lugar de `backendPost`: backendPost descarta el
      // body del error y deja solo el status, y acá necesitamos
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
          telefono: telNorm || undefined
        })
      });

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(traducirErrorRegistro((result?.error as string) || ''));
        setSubmitting(false);
        return;
      }

      setCreado({ nombre: nombreNorm, email: emailNorm, password });
    } catch (err) {
      toast.error(traducirErrorRegistro(err instanceof Error ? err.message : ''));
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!creado) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const text = [
      'EKKO Studio — Tu acceso',
      '',
      `Nombre: ${creado.nombre}`,
      `Email: ${creado.email}`,
      `Contraseña: ${creado.password}`,
      '',
      `Iniciá sesión en: ${origin}/login`
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiado(true);
      toast.success('Credenciales copiadas.');
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      toast.error('No se pudo copiar. Anotá las credenciales manualmente.');
    }
  }

  return (
    <div
      onClick={() => !submitting && !creado && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Registrar miembro"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
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
            copiado={copiado}
            onCopy={handleCopy}
            onCerrar={() => onRegistrado(creado.email)}
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
                  style={{ width: '44px', minHeight: '44px', padding: 0, fontSize: '16px' }}
                >
                  🔄
                </button>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
                Autogenerada. Se la das al cliente; podrá cambiarla desde el login.
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
                className="ek-cta"
                style={{ flex: 1, minHeight: '44px', opacity: canSubmit ? 1 : 0.5 }}
              >
                {submitting ? 'Registrando…' : 'Registrar miembro'}
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
  copiado,
  onCopy,
  onCerrar
}: {
  creado: MiembroCreado;
  copiado: boolean;
  onCopy: () => void;
  onCerrar: () => void;
}) {
  return (
    <>
      <p
        className="ek-eyebrow"
        style={{ marginBottom: '6px', color: 'var(--ek-success)' }}
      >
        ✓ MIEMBRO REGISTRADO
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
        Entregá estas credenciales a {creado.nombre}
      </h3>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '16px' }}>
        Compartilas verbalmente o por WhatsApp. El cliente las usa para entrar a EKKO.
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

      <button
        type="button"
        onClick={onCopy}
        className="ek-cta ek-cta--full"
        style={{ padding: '12px', fontSize: '14px', minHeight: '44px', marginBottom: '14px' }}
      >
        {copiado ? '✓ Copiado' : '📋 Copiar credenciales'}
      </button>

      <p
        style={{
          fontSize: '12px',
          color: 'var(--ek-mustard)',
          background: 'var(--ek-mustard-soft)',
          padding: '12px 14px',
          borderRadius: 'var(--ek-r-sm)',
          margin: 0,
          marginBottom: '20px',
          lineHeight: 1.55
        }}
      >
        ⚠️ La cuenta queda <strong>PENDIENTE DE ACTIVACIÓN</strong> — se activa al confirmar el
        pago/plan con administración. Mientras tanto el miembro no podrá reservar.
      </p>

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
