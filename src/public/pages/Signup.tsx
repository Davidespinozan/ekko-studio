import { useEffect, useState, FormEvent } from 'react';
import { useNavigate, useSearchParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Star, Check, Eye, EyeOff, AlertCircle, User, ShieldCheck } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { parseBeneficios } from '@shared/lib/beneficios';
import { iniciarCheckout } from '@shared/lib/checkout';
import { Spinner } from '@shared/components/Spinner';

type Tier = 'basica' | 'pro';

interface PlanInfo {
  nombre: string;
  precio: number;
  tier: Tier;
  beneficios: string[];
}

interface TierRow {
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: unknown;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useTierPorSlug(slug: string) {
  const [tier, setTier] = useState<TierRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, beneficios')
        .eq('slug', slug)
        .eq('activo', true)
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tierParam = (searchParams.get('tier') as Tier) || 'basica';
  const { tier: tierRow, isLoading: tierLoading } = useTierPorSlug(tierParam);

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [acepto, setAcepto] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false); // cuenta creada → pantalla de bienvenida

  const plan: PlanInfo | null = tierRow
    ? {
        nombre: tierRow.nombre,
        precio: Math.round(tierRow.precio_centavos / 100),
        tier: tierRow.slug as Tier,
        beneficios: parseBeneficios(tierRow.beneficios)
          .filter((b) => b.incluido)
          .map((b) => b.label)
          .slice(0, 4)
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const emailNorm = email.trim().toLowerCase();
    const nombreNorm = nombre.trim();

    if (nombreNorm.length < 2) {
      setError('Ingresá tu nombre completo.');
      return;
    }
    if (!EMAIL_REGEX.test(emailNorm)) {
      setError('Ingresá un email válido.');
      return;
    }
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    if (!acepto) {
      setError('Debés aceptar los términos y el aviso de privacidad para continuar.');
      return;
    }

    setIsProcessing(true);

    try {
      const response = await fetch('/.netlify/functions/fake-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: nombreNorm,
          email: emailNorm,
          password,
          tier: plan!.tier
        })
      });

      const result = await response.json();

      if (!response.ok) {
        const errMsg = String(result.error ?? '').toLowerCase();
        if (
          errMsg.includes('already') ||
          errMsg.includes('registered') ||
          errMsg.includes('exists') ||
          errMsg.includes('duplicate')
        ) {
          throw new Error('Ya existe una cuenta con este email. Iniciá sesión.');
        }
        throw new Error(result.error || 'No se pudo crear la cuenta.');
      }

      // Auto-login para dejar sesión activa (necesaria para el pago).
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: emailNorm,
        password
      });
      if (loginError) {
        throw new Error('Cuenta creada pero no pudimos iniciar sesión. Iniciá sesión manualmente.');
      }

      // Pago: si Stripe está conectado, iniciarCheckout redirige a la pasarela.
      // Si no, cae a la pantalla de bienvenida (el pago se coordina en recepción).
      const checkout = await iniciarCheckout(plan!.tier);
      if (checkout.url) return; // redirigiendo a Stripe
      setListo(true);
    } catch (err) {
      console.error('[Signup]', err);
      setError(err instanceof Error ? err.message : 'Error inesperado. Intentá de nuevo.');
      setIsProcessing(false);
    }
  }

  if (tierLoading) {
    return (
      <div style={{ maxWidth: '480px', margin: '40px auto', padding: '0 24px' }}>
        <div className="ek-skeleton" style={{ height: '600px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (!plan) {
    return <Navigate to="/" replace />;
  }

  // Pantalla de bienvenida (qué recibe el suscriptor al concluir el registro).
  if (listo) {
    return (
      <div style={{ maxWidth: '480px', margin: '0 auto', padding: '48px 24px', minHeight: '100dvh' }}>
        <div className="ek-card" style={{ padding: '32px', textAlign: 'center' }}>
          <span className="ek-empty-icon" style={{ width: 64, height: 64, marginBottom: '18px' }}>
            <ShieldCheck size={30} aria-hidden="true" />
          </span>
          <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
            ¡Bienvenido/a a EKKO!
          </h1>
          <p className="ek-body-muted" style={{ margin: '0 0 24px' }}>
            Tu cuenta quedó creada con el plan <strong style={{ color: 'var(--ek-mustard)' }}>{plan.nombre}</strong>.
          </p>

          <div className="ek-card ek-card--md" style={{ textAlign: 'left', marginBottom: '24px' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>PRÓXIMOS PASOS</p>
            <ol style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', lineHeight: 1.5 }}>
              <li>En tu <strong>primera visita</strong>, recepción toma tu foto y tus datos (INE).</li>
              <li>Firmás el <strong>contrato de uso</strong> del estudio.</li>
              <li>Activamos tu membresía y <strong>¡a grabar!</strong></li>
            </ol>
          </div>

          <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => navigate('/app')}>
            Ir a mi cuenta
          </button>
          <p className="ek-helper-text" style={{ marginTop: '12px' }}>
            El pago de tu membresía se coordina en recepción.
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
        borderColor: plan.tier === 'pro' ? 'var(--ek-mustard)' : 'var(--ek-line)',
        position: 'sticky',
        top: 'env(safe-area-inset-top, 0px)',
        zIndex: 5,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)'
      }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          {plan.tier === 'pro' && <Star size={12} fill="currentColor" aria-hidden="true" />}
          {plan.tier === 'pro' ? 'PRO · MEMBRESÍA' : 'MEMBRESÍA BÁSICA'}
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
          <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span>
        </p>
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
          <label className="ek-label" htmlFor="signup-password">Contraseña</label>
          <div style={{ position: 'relative' }}>
            <input
              id="signup-password"
              type={showPassword ? 'text' : 'password'}
              className="ek-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              disabled={isProcessing}
              autoComplete="new-password"
              style={{ paddingRight: '48px' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)' }}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <p className="ek-helper-text">Mínimo 8 caracteres.</p>
        </div>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="signup-password-confirm">Confirmar contraseña</label>
          <input
            id="signup-password-confirm"
            type={showPassword ? 'text' : 'password'}
            className="ek-input"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            required
            disabled={isProcessing}
            autoComplete="new-password"
          />
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
            Acepto los <strong style={{ color: 'var(--ek-ink)' }}>términos y condiciones</strong> y el{' '}
            <strong style={{ color: 'var(--ek-ink)' }}>aviso de privacidad</strong>. Compromiso mínimo de 6 meses.
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
          {isProcessing ? <Spinner size={18} label="Creando tu cuenta…" /> : 'Crear mi cuenta'}
        </button>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          textAlign: 'center',
          marginTop: '4px',
          lineHeight: 1.5
        }}>
          El pago es seguro vía Stripe. En tu primera visita en recepción tomamos tus datos y activamos tu membresía.
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
