import { useState, type FormEvent } from 'react';
import { ArrowLeft, Mail } from 'lucide-react';
import { AccesoLayout } from '../components/AccesoLayout';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { validarEmail } from '../lib/recuperacionLogic';


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
    <AccesoLayout>
      <Link to="/login" className="ek-acceso-volver">
        <ArrowLeft size={15} aria-hidden="true" /> Volver al login
      </Link>
          {enviado ? (
            <div className="ek-stack-md">
              <span className="ek-kicker">Revisa tu correo</span>
              <h2 className="ek-acceso-h1">Listo</h2>
              <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
                Si existe una cuenta con ese email, te llegará un enlace para crear una contraseña nueva
                (revisa también spam). <strong>Si no te llega en unos minutos, pide en recepción que te
                restablezcan el acceso.</strong>
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="ek-stack-md">
              <span className="ek-kicker">Recuperar contraseña</span>
              <h2 className="ek-acceso-h1">¿Olvidaste tu contraseña?</h2>
              <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
                Escribe tu email y te enviamos un enlace para crear una nueva.
              </p>
              <div className="ek-form-field">
                <label htmlFor="rec-email" className="ek-label">Email</label>
                <div className="ek-campo">
                  <Mail size={16} aria-hidden="true" />
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
              </div>
              {error && <p className="ek-error-text">{error}</p>}
              <button type="submit" className="ek-cta ek-cta--gold ek-cta--full" disabled={enviando || !email}>
                {enviando ? 'Enviando…' : 'Enviar enlace de recuperación'}
              </button>
            </form>
          )}
    </AccesoLayout>
  );
}
