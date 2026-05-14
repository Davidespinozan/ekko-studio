import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

export default function Signup() {
  const navigate = useNavigate();
  const tenant = useTenant();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            tenant_slug: tenant.slug,
            nombre: nombre.trim(),
            telefono: telefono.trim() || null
          }
        }
      });

      if (signUpError) {
        setError(traducirError(signUpError.message));
        setIsSubmitting(false);
        return;
      }

      // Si la confirmación de email está activa, no hay sesión aún
      if (!data.session) {
        setSuccess(true);
        setIsSubmitting(false);
        return;
      }

      // Si hay sesión inmediata, el useRoleRedirect del PublicLayout
      // hace el redirect por rol.
      navigate('/', { replace: true });
    } catch (err) {
      setError('Error inesperado. Intenta de nuevo.');
      setIsSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="ek-container ek-container--narrow">
        <div className="ek-stack-lg">
          <p className="ek-eyebrow">REVISA TU EMAIL</p>
          <h1 className="ek-h2">¡Casi listo!</h1>
          <p className="ek-body">
            Te enviamos un enlace de confirmación a <strong>{email}</strong>.
            Haz click ahí para activar tu cuenta.
          </p>
          <Link to="/login" className="ek-cta ek-cta--secondary ek-cta--full">
            Volver al inicio de sesión
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="ek-container ek-container--narrow">
      <div className="ek-stack-lg">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">CREAR CUENTA</p>
          <h1 className="ek-h2">Únete a {tenant.nombre}</h1>
          <p className="ek-body">
            Empieza a crear contenido profesional hoy.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="ek-stack-md">
          <div className="ek-form-field">
            <label htmlFor="nombre" className="ek-label">Nombre completo</label>
            <input
              id="nombre"
              type="text"
              autoComplete="name"
              required
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="ek-input"
              placeholder="María González"
            />
          </div>

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
            <label htmlFor="telefono" className="ek-label">
              Teléfono <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input
              id="telefono"
              type="tel"
              autoComplete="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              className="ek-input"
              placeholder="+52 667 123 4567"
            />
          </div>

          <div className="ek-form-field">
            <label htmlFor="password" className="ek-label">Contraseña</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ek-input"
              placeholder="Mínimo 8 caracteres"
            />
            <p className="ek-helper-text">Al menos 8 caracteres.</p>
          </div>

          {error && <p className="ek-error-text">{error}</p>}

          <button
            type="submit"
            className="ek-cta ek-cta--full"
            disabled={isSubmitting || !email || !password || !nombre}
          >
            {isSubmitting ? 'Creando cuenta…' : 'Crear cuenta'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: '0.9375rem', color: 'var(--ek-ink-muted)' }}>
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" style={{ color: 'var(--ek-black)', fontWeight: 600 }}>
            Iniciar sesión
          </Link>
        </p>
      </div>
    </div>
  );
}

function traducirError(message: string): string {
  if (message.includes('User already registered')) {
    return 'Ya existe una cuenta con este email. Inicia sesión.';
  }
  if (message.includes('Password should be')) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  if (message.includes('Unable to validate email')) {
    return 'El email no es válido.';
  }
  return message;
}
