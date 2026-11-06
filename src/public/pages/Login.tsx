import { useEffect, useState, FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, AlertCircle, Mail, Lock } from 'lucide-react';
import { AccesoLayout } from '../components/AccesoLayout';
import { supabase } from '@shared/lib/supabase';
import { Spinner } from '@shared/components/Spinner';
import { ContactoEstudio } from '@shared/components/ContactoEstudio';
import { validarStatusSegunRol, traducirErrorAuth } from '@shared/lib/validarStatusCuenta';
import { suspendidoPorPausa, MENSAJE_EN_PAUSA } from '@shared/lib/pausaMembresia';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
        .select('id, rol, status')
        .eq('auth_id', authData.user.id)
        .maybeSingle();

      if (perfilError || !perfil) {
        await supabase.auth.signOut();
        setError('No encontramos tu cuenta. Contacta al estudio.');
        setIsSubmitting(false);
        return;
      }

      // 3. Validar status ANTES del redirect (evita el flash de /app).
      // Excepción: `pendiente_pago` entra a /app para pagar su membresía (self-serve).
      // Solo MIEMBROS: un recepcionista/admin "pendiente de pago" no existe.
      if (perfil.status === 'pendiente_pago' && perfil.rol === 'miembro') {
        navigate('/app', { replace: true });
        return;
      }
      // Staff: solo `activo` entra al panel (un miembro `cancelado` sí entra, a recomprar).
      const validacion = validarStatusSegunRol(perfil);
      if (!validacion.permitido) {
        // Suspendido por una PAUSA (viaje, lesión) ≠ suspendido por el admin: se
        // consulta antes de cerrar la sesión (después ya no podría leer sus filas).
        const enPausa =
          perfil.status === 'suspendido' && perfil.rol === 'miembro' && (await suspendidoPorPausa(perfil.id));
        await supabase.auth.signOut();
        setError(enPausa ? MENSAJE_EN_PAUSA : validacion.mensaje ?? 'Tu cuenta no está activa.');
        setIsSubmitting(false);
        return;
      }

      // 4. Status OK — redirect directo según rol (sin saltos intermedios).
      if (perfil.rol === 'admin') navigate('/admin', { replace: true });
      else if (perfil.rol === 'recepcionista') navigate('/recepcion', { replace: true });
      else navigate('/app', { replace: true });
    } catch {
      setError('No pudimos iniciar sesión. Intenta de nuevo o contacta al estudio.');
      setIsSubmitting(false);
    }
  }

  return (
    <AccesoLayout>
      <Link to="/" className="ek-acceso-volver">
        <ArrowLeft size={15} aria-hidden="true" /> Volver a EKKO
      </Link>
      <span className="ek-kicker">Tu cuenta EKKO</span>
      <h1 className="ek-acceso-h1">Iniciar sesión</h1>
      <p className="ek-acceso-sub">Entra con tu email y contraseña.</p>

      <form onSubmit={handleSubmit} className="ek-stack-md">
        <div className="ek-form-field">
          <label htmlFor="email" className="ek-label">Email</label>
          <div className="ek-campo">
            <Mail size={16} aria-hidden="true" />
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
        </div>

        <div className="ek-form-field">
          <label htmlFor="password" className="ek-label">Contraseña</label>
          <div className="ek-campo">
            <Lock size={16} aria-hidden="true" />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ek-input"
              placeholder="••••••••"
              style={{ paddingRight: '52px' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' }}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        {error && (
          <p className="ek-error-text" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
            <span>
              {error}
              {/* A12: si el mensaje manda a contactar al estudio, que haya cómo. */}
              {/contacta|escr[ií]bele|recepci[oó]n/i.test(error) && (
                <>
                  {' '}
                  <ContactoEstudio enLinea etiqueta="Escríbenos por WhatsApp" mensaje={`Hola, no puedo entrar a mi cuenta de EKKO (${email.trim() || 'sin email'}): ${error}`} />
                </>
              )}
            </span>
          </p>
        )}

        <button
          type="submit"
          className="ek-cta ek-cta--gold ek-cta--full"
          disabled={isSubmitting || !email || !password}
        >
          {isSubmitting ? <Spinner size={16} label="Iniciando sesión…" /> : 'Iniciar sesión'}
        </button>

        <div className="ek-acceso-fila-fin">
          <Link to="/recuperar">¿Olvidaste tu contraseña?</Link>
        </div>
      </form>
    </AccesoLayout>
  );
}
