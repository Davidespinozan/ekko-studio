import { useEffect, useState, FormEvent } from 'react';
import { useSearchParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Check, AlertCircle, User, Mail } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { parseBeneficios } from '@shared/lib/beneficios';
import { sufijoPrecio, detallePlan } from '@shared/lib/planPresentacion';
import { Spinner } from '@shared/components/Spinner';

interface PlanInfo {
  nombre: string;
  precio: number;
  tier: string; // slug del plan elegido (paquete de créditos o mensual)
  beneficios: string[];
  esPaquete: boolean;
  tipo: string;
  clases_incluidas: number | null;
  duracion_dias: number | null;
}

interface TierRow {
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: unknown;
  tipo: string;
  clases_incluidas: number | null;
  duracion_dias: number | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PKG-06C: lo mismo que dice el servidor; respaldo si la respuesta no trae texto. */
const MENSAJE_NEUTRO =
  'Si el correo puede usarse para una cuenta nueva, te enviamos un enlace para confirmarlo. Revisa tu bandeja de entrada y la carpeta de spam. Si ya tienes cuenta, inicia sesión.';
const ESPERA_REENVIO_MS = 60_000;

interface Enviado {
  nombre: string;
  email: string;
  mensaje: string;
}

function useTierPorSlug(slug: string) {
  const [tier, setTier] = useState<TierRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, beneficios, tipo, clases_incluidas, duracion_dias')
        .eq('slug', slug)
        .eq('activo', true)
        .eq('en_venta', true)
        .maybeSingle();

      if (!mounted) return;
      if (error) console.error('[useTierPorSlug]', error);
      else setTier(data as TierRow | null);
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slug]);

  return { tier, isLoading };
}

export default function Signup() {
  const [searchParams] = useSearchParams();
  // El slug viene del landing (/signup?tier=<slug>). Sin plan válido → redirige.
  const tierParam = searchParams.get('tier') ?? '';
  const { tier: tierRow, isLoading: tierLoading } = useTierPorSlug(tierParam);

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [emailConfirm, setEmailConfirm] = useState('');
  const [acepto, setAcepto] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PKG-06C: tras pedir el alta se espera al correo; reenviar se habilita al minuto.
  const [enviado, setEnviado] = useState<Enviado | null>(null);
  const [puedeReenviar, setPuedeReenviar] = useState(false);

  useEffect(() => {
    if (!enviado) return;
    setPuedeReenviar(false);
    const t = setTimeout(() => setPuedeReenviar(true), ESPERA_REENVIO_MS);
    return () => clearTimeout(t);
  }, [enviado]);

  const plan: PlanInfo | null = tierRow
    ? {
        nombre: tierRow.nombre,
        precio: Math.round(tierRow.precio_centavos / 100),
        tier: tierRow.slug,
        beneficios: parseBeneficios(tierRow.beneficios)
          .filter((b) => b.incluido)
          .map((b) => b.label)
          .slice(0, 4),
        esPaquete: tierRow.tipo === 'creditos' || tierRow.tipo === 'hibrido',
        tipo: tierRow.tipo,
        clases_incluidas: tierRow.clases_incluidas,
        duracion_dias: tierRow.duracion_dias
      }
    : null;

  // Mobile: al enfocar un input, scrollearlo al centro para que el teclado
  // iOS no lo tape.
  const handleFormFocus = (e: React.FocusEvent<HTMLFormElement>) => {
    const target = e.target;
    if (target instanceof HTMLInputElement) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  };

  /**
   * PKG-06C (FR-24): el alta pública solo PIDE la cuenta. El servidor responde
   * igual exista o no (sin enumeración) y manda un enlace al correo; la cuenta
   * nace cuando el dueño del buzón lo abre, y ahí elige su contraseña. Aquí no
   * se crea sesión ni se inicia sesión.
   */
  async function solicitarAlta(nombreNorm: string, emailNorm: string): Promise<void> {
    setIsProcessing(true);
    setError(null);
    try {
      const response = await fetch('/.netlify/functions/alta-publica', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: nombreNorm, email: emailNorm, tier: plan!.tier, acepto: true })
      });
      const result = (await response.json().catch(() => ({}))) as { error?: unknown; seguro?: unknown; mensaje?: unknown };
      if (!response.ok) {
        // PKG-06D: un 5xx sin `seguro` no se muestra crudo; los 4xx y los marcados `seguro` traen texto escrito a mano.
        const legible = typeof result.error === 'string' && (response.status < 500 || result.seguro === true);
        throw new Error(legible ? (result.error as string) : 'No pudimos procesar tu registro. Intenta de nuevo.');
      }
      setEnviado({ nombre: nombreNorm, email: emailNorm, mensaje: typeof result.mensaje === 'string' ? result.mensaje : MENSAJE_NEUTRO });
    } catch (err) {
      console.error('[Signup]', err);
      setError(err instanceof Error ? err.message : 'Error inesperado. Intenta de nuevo.');
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isProcessing) return;
    setError(null);

    const emailNorm = email.trim().toLowerCase();
    const nombreNorm = nombre.trim();

    if (nombreNorm.length < 2) {
      setError('Ingresa tu nombre completo.');
      return;
    }
    if (!EMAIL_REGEX.test(emailNorm)) {
      setError('Ingresa un email válido.');
      return;
    }
    if (emailNorm !== emailConfirm.trim().toLowerCase()) {
      setError('Los emails no coinciden. Verifica que estén iguales.');
      return;
    }
    if (!acepto) {
      setError('Debes aceptar los términos y el aviso de privacidad para continuar.');
      return;
    }
    await solicitarAlta(nombreNorm, emailNorm);
  }

  if (tierLoading) {
    return (
      <div style={{ maxWidth: '480px', margin: '40px auto', padding: '0 24px' }}>
        <div className="ek-skeleton" style={{ height: '600px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (!plan) {
    // Sin plan válido en la URL → mandalo a elegir uno en el landing.
    return <Navigate to="/#membresias" replace />;
  }

  if (enviado) {
    return (
      <div style={{ maxWidth: '480px', margin: '0 auto', padding: '40px 24px', minHeight: '100dvh' }}>
        <div className="ek-card ek-stack-md" style={{ padding: '24px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ margin: 0 }}>
            <Mail size={13} aria-hidden="true" /> REVISA TU CORREO
          </p>
          <h2 className="ek-h3" style={{ margin: 0 }}>Confirma tu correo para continuar</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }} role="status">{enviado.mensaje}</p>
          <p className="ek-body-muted" style={{ margin: 0, fontSize: '13px', lineHeight: 1.55 }}>
            Correo indicado: <strong>{enviado.email}</strong>. El enlace vence en 1 hora y solo funciona una vez; al abrirlo eliges tu contraseña.
          </p>
          {error && <p className="ek-error-text" role="alert" style={{ margin: 0 }}>{error}</p>}
          <button
            type="button"
            className="ek-cta ek-cta--full"
            disabled={!puedeReenviar || isProcessing}
            onClick={() => void solicitarAlta(enviado.nombre, enviado.email)}
          >
            {isProcessing ? <Spinner size={18} label="Enviando…" /> : puedeReenviar ? 'Enviar el enlace de nuevo' : 'Podrás pedir otro enlace en un minuto'}
          </button>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', textAlign: 'center', margin: 0 }}>
            ¿Ya tienes cuenta? <Link to="/login" style={{ color: 'var(--ek-mustard)' }}>Iniciar sesión</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: '480px',
      margin: '0 auto',
      padding: '40px 24px',
      paddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
      minHeight: '100dvh'
    }}>
      <Link to="/" style={{
        fontSize: '13px',
        color: 'var(--ek-ink-muted)',
        textDecoration: 'none',
        marginBottom: '32px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px'
      }}>
        <ArrowLeft size={15} aria-hidden="true" /> Volver a EKKO
      </Link>

      <div className="ek-card" style={{
        padding: '24px',
        marginBottom: '32px',
        borderColor: 'var(--ek-mustard)',
        position: 'sticky',
        top: 'env(safe-area-inset-top, 0px)',
        zIndex: 5,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)'
      }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
          {plan.esPaquete ? 'PAQUETE DE CRÉDITOS' : 'MEMBRESÍA'}
        </p>
        <p style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '36px',
          fontWeight: 700,
          margin: 0,
          letterSpacing: '-0.03em',
          lineHeight: 1
        }}>
          ${plan.precio.toLocaleString('es-MX')}
          <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>{sufijoPrecio(plan)}</span>
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '6px 0 0' }}>{detallePlan(plan)}</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {plan.beneficios.map((b) => (
            <li key={b} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} aria-hidden="true" />{b}
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={handleSubmit} onFocus={handleFormFocus} className="ek-stack-md">
        <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '4px' }}>
          <User size={13} aria-hidden="true" /> TUS DATOS
        </p>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-nombre">Nombre completo</label>
          <input
            id="signup-nombre"
            type="text"
            className="ek-input"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
            disabled={isProcessing}
            autoComplete="name"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            className="ek-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isProcessing}
            autoComplete="email"
          />
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-email-confirm">Confirmar email</label>
          <input
            id="signup-email-confirm"
            type="email"
            className="ek-input"
            value={emailConfirm}
            onChange={(e) => setEmailConfirm(e.target.value)}
            onPaste={(e) => e.preventDefault()}
            required
            disabled={isProcessing}
            autoComplete="off"
          />
          <p className="ek-helper-text">Escríbelo de nuevo para confirmar (aquí llegan tus accesos y comprobantes).</p>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginTop: '8px', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={acepto}
            onChange={(e) => setAcepto(e.target.checked)}
            disabled={isProcessing}
            style={{ marginTop: '3px', flexShrink: 0 }}
          />
          <span>
            Acepto los{' '}
            <a href="/terminos" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ek-mustard)', fontWeight: 600 }}>
              términos y condiciones
            </a>{' '}
            y el{' '}
            <a href="/privacidad" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ek-mustard)', fontWeight: 600 }}>
              aviso de privacidad
            </a>
            .
          </span>
        </label>

        {error && (
          <div style={{
            background: 'var(--ek-danger-soft)',
            border: '0.5px solid var(--ek-danger)',
            borderRadius: 'var(--ek-r-sm)',
            padding: '12px 16px',
            color: 'var(--ek-danger)',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px'
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          className="ek-cta ek-cta--full"
          style={{ marginTop: '12px', padding: '16px', fontSize: '15px' }}
          disabled={isProcessing}
        >
          {isProcessing ? <Spinner size={18} label="Enviando…" /> : 'Crear mi cuenta'}
        </button>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          textAlign: 'center',
          marginTop: '4px',
          lineHeight: 1.5
        }}>
          Te mandamos un enlace para confirmar tu correo; al abrirlo eliges tu contraseña y pagas tu plan.{' '}
          {plan.esPaquete
            ? 'Es un pago único, sin mensualidad. '
            : 'Es una membresía mensual: se cobra automáticamente cada mes. '}
          El pago es seguro vía Stripe. En tu primera visita en recepción tomamos tus datos y activamos tu plan.
        </p>

        <p style={{
          fontSize: '12px',
          color: 'var(--ek-ink-muted)',
          textAlign: 'center',
          marginTop: '12px'
        }}>
          ¿Ya tienes cuenta? <Link to="/login" style={{ color: 'var(--ek-mustard)' }}>Iniciar sesión</Link>
        </p>
      </form>
    </div>
  );
}
