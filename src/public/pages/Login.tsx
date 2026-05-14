import { useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (signInError) {
        setError(traducirError(signInError.message));
        setIsSubmitting(false);
        return;
      }

      navigate('/app');
    } catch (err) {
      setError('Error inesperado. Intenta de nuevo.');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="ek-container ek-container--narrow">
      <div className="ek-stack-lg">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">INICIAR SESIÓN</p>
          <h1 className="ek-h2">Bienvenido de vuelta</h1>
          <p className="ek-body">
            Accede a tu espacio para reservar y crear contenido.
          </p>
        </div>

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
            {isSubmitting ? 'Entrando…' : 'Iniciar sesión'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: '0.9375rem', color: 'var(--ek-ink-muted)' }}>
          ¿No tienes cuenta?{' '}
          <Link to="/signup" style={{ color: 'var(--ek-black)', fontWeight: 600 }}>
            Crear cuenta
          </Link>
        </p>
      </div>
    </div>
  );
}

function traducirError(message: string): string {
  if (message.includes('Invalid login credentials')) {
    return 'Email o contraseña incorrectos';
  }
  if (message.includes('Email not confirmed')) {
    return 'Necesitas confirmar tu email primero';
  }
  if (message.includes('Too many requests')) {
    return 'Demasiados intentos. Espera unos minutos.';
  }
  return message;
}
