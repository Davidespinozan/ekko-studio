import { useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { PasswordInput } from '@shared/components/PasswordInput';
import { validarNuevaContrasena, traducirErrorRecuperacion } from '@public/lib/recuperacionLogic';

interface Props {
  /** Se llama cuando Supabase confirmó el cambio. */
  onSuccess: () => void | Promise<void>;
  ctaLabel?: string;
  autoFocus?: boolean;
}

/**
 * Formulario "nueva contraseña + repetir" que llama a `auth.updateUser`.
 * Lo comparten el perfil del miembro (cambio voluntario), el gate de clave
 * temporal y la pantalla /nueva-contrasena (enlace de recuperación).
 */
export function CambiarPasswordForm({ onSuccess, ctaLabel = 'Guardar contraseña', autoFocus }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coincide = confirm.length === 0 || password === confirm;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validarNuevaContrasena(password, confirm);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) {
      setError(traducirErrorRecuperacion(err.message));
      setSaving(false);
      return;
    }
    await onSuccess();
    setSaving(false);
  }

  return (
    <form onSubmit={handleSubmit} className="ek-stack-md">
      <div className="ek-form-field">
        <label htmlFor="cp-password" className="ek-label">Nueva contraseña</label>
        <PasswordInput id="cp-password" value={password} onChange={setPassword} required autoFocus={autoFocus} minLength={8} />
        <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>Mínimo 8 caracteres, con una letra y un número.</span>
      </div>
      <div className="ek-form-field">
        <label htmlFor="cp-confirm" className="ek-label">Repite la contraseña</label>
        <PasswordInput id="cp-confirm" value={confirm} onChange={setConfirm} required placeholder="La misma otra vez" />
        {!coincide && <span className="ek-error-text">No coinciden.</span>}
      </div>
      {error && <p className="ek-error-text">{error}</p>}
      <button
        type="submit"
        className="ek-cta ek-cta--full"
        disabled={saving || !password || !confirm || !coincide}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
      >
        <Lock size={16} aria-hidden="true" />
        {saving ? 'Guardando…' : ctaLabel}
      </button>
    </form>
  );
}
