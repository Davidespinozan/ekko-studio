import { useEffect, useState, FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { validarStatusCuenta, traducirErrorAuth } from '@shared/lib/validarStatusCuenta';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mensaje que viene del guard de MemberLayout (sesión vieja invalidada).
  useEffect(() => {
    const state = location.state as { mensaje?: string } | null;
    if (state?.mensaje) {
      setError(state.mensaje);
      // Limpiar el state para que no reaparezca al refrescar.
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // 1. Autenticar.
      const { data: authData, error: signInError } =
        await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password
        });

      if (signInError || !authData.user) {
        setError(traducirErrorAuth(signInError?.message ?? ''));
        setIsSubmitting(false);
        return;
      }

      // 2. Traer perfil + status ANTES de cualquier redirect.
      const { data: perfil, error: perfilError } = await supabase
        .from('usuarios')
        .select('rol, status')
        .eq('auth_id', authData.user.id)
        .maybeSingle();

      if (perfilError || !perfil) {
        await supabase.auth.signOut();
        setError('No encontramos tu cuenta. Contactá al estudio.');
        setIsSubmitting(false);
        return;
      }

      // 3. Validar status ANTES del redirect (evita el flash de /app).
      const validacion = validarStatusCuenta(perfil);
      if (!validacion.permitido) {
        await supabase.auth.signOut();
        setError(validacion.mensaje ?? 'Tu cuenta no está activa.');
        setIsSubmitting(false);
        return;
      }

      // 4. Status OK — redirect directo según rol (sin saltos intermedios).
      if (perfil.rol === 'admin') navigate('/admin', { replace: true });
      else if (perfil.rol === 'recepcionista') navigate('/recepcion', { replace: true });
      else navigate('/app', { replace: true });
    } catch {
      setError('No pudimos iniciar sesión. Intentá de nuevo o contactá al estudio.');
      setIsSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '24px 20px',
      paddingTop: 'clamp(48px, 12vh, 120px)',
      paddingBottom: 'calc(48px + env(safe-area-inset-bottom, 0px))'
    }}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <h1 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '36px',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            color: 'var(--ek-mustard)',
            margin: 0
          }}>EKKO</h1>
          <p className="ek-eyebrow" style={{ marginTop: '6px' }}>STUDIO</p>
        </div>

        <div className="ek-card">
          <form onSubmit={handleSubmit} className="ek-stack-md">
            <div className="ek-form-field">
              <label htmlFor="email" className="ek-label">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="ek-input"
                placeholder="tu@email.com"
              />
            </div>

            <div className="ek-form-field">
              <label htmlFor="password" className="ek-label">Contraseña</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="ek-input"
                placeholder="••••••••"
              />
            </div>

            {error && <p className="ek-error-text">{error}</p>}

            <button
              type="submit"
              className="ek-cta ek-cta--full"
              disabled={isSubmitting || !email || !password}
            >
              {isSubmitting ? 'Iniciando sesión…' : 'Iniciar sesión'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
