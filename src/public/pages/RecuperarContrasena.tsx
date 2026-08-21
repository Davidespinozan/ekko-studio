import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { validarEmail } from '../lib/recuperacionLogic';

const WRAP: React.CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  padding: '0 20px',
  paddingTop: 'clamp(56px, 10vh, 120px)',
  paddingBottom: 'calc(48px + env(safe-area-inset-bottom, 0px))'
};

const VOLVER: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--ek-mustard)',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px'
};

/**
 * /recuperar — el miembro (o el staff) pide un enlace para restablecer su
 * contraseña. Antes no existía: quien olvidaba la clave dependía de ir al
 * mostrador. El enlace vuelve a /nueva-contrasena.
 */
export default function RecuperarContrasena() {
  const [email, setEmail] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validarEmail(email);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setEnviando(true);
    const redirectTo = `${window.location.origin}/nueva-contrasena`;
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
    setEnviando(false);

    // Rate limit sí se muestra (no revela si el email existe).
    if (err && /rate|too many/i.test(err.message)) {
      setError('Demasiados intentos. Espera unos minutos.');
      return;
    }
    if (err) console.error('[recuperar-contrasena]', err);
    // SEGURIDAD: mismo mensaje exista o no el email.
    setEnviado(true);
  }

  return (
    <div style={WRAP}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div className="ek-card">
          {enviado ? (
            <div className="ek-stack-md">
              <p className="ek-eyebrow" style={{ margin: 0 }}>REVISA TU CORREO</p>
              <h2 className="ek-h3" style={{ margin: 0 }}>Listo</h2>
              <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
                Si existe una cuenta con ese email, te llegará un enlace para crear una contraseña nueva
                (revisa también spam). <strong>Si no te llega en unos minutos, pide en recepción que te
                restablezcan el acceso.</strong>
              </p>
              <Link to="/login" style={VOLVER}>
                <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" /> Volver al login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="ek-stack-md">
              <p className="ek-eyebrow" style={{ margin: 0 }}>RECUPERAR CONTRASEÑA</p>
              <h2 className="ek-h3" style={{ margin: 0 }}>¿Olvidaste tu contraseña?</h2>
              <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
                Escribe tu email y te enviamos un enlace para crear una nueva.
              </p>
              <div className="ek-form-field">
                <label htmlFor="rec-email" className="ek-label">Email</label>
                <input
                  id="rec-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="ek-input"
                  placeholder="tu@email.com"
                />
              </div>
              {error && <p className="ek-error-text">{error}</p>}
              <button type="submit" className="ek-cta ek-cta--full" disabled={enviando || !email}>
                {enviando ? 'Enviando…' : 'Enviar enlace de recuperación'}
              </button>
              <Link to="/login" style={VOLVER}>
                <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" /> Volver al login
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
