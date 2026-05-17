import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';

type Rol = 'admin' | 'recepcionista';

interface Props {
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function InvitarPersonaModal({ onClose, onCreated }: Props) {
  const tenant = useTenant();
  const toast = useToast();

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [rol, setRol] = useState<Rol>('recepcionista');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  const nombreValido = nombre.trim().length >= 2;
  const emailValido = EMAIL_REGEX.test(email.trim());
  const canSubmit = nombreValido && emailValido && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const emailNormalizado = email.trim().toLowerCase();

    // Email duplicado dentro del tenant
    const { data: existing, error: checkErr } = await supabase
      .from('usuarios')
      .select('id, status')
      .eq('tenant_id', tenant.id)
      .eq('email', emailNormalizado)
      .maybeSingle();

    if (checkErr) {
      setError('No se pudo verificar duplicado: ' + checkErr.message);
      setSubmitting(false);
      return;
    }
    if (existing) {
      setError('Ya existe una persona con ese email en tu equipo.');
      setSubmitting(false);
      return;
    }

    // Insert row con invitado=true. auth_id se llena cuando complete signup.
    const { error: insertErr } = await supabase.from('usuarios').insert({
      tenant_id: tenant.id,
      nombre: nombre.trim(),
      email: emailNormalizado,
      rol,
      status: 'pendiente_onboarding',
      invitado: true,
      auth_id: null
    } as never);

    if (insertErr) {
      setError(insertErr.message);
      setSubmitting(false);
      return;
    }

    toast.success(`Invitación enviada a ${emailNormalizado}.`);
    setSubmitting(false);
    await onCreated();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '540px',
          width: '100%',
          padding: '28px',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          INVITAR PERSONA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '20px'
          }}
        >
          Invitar persona al equipo
        </h3>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Nombre completo</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Juan Pérez"
            required
            minLength={2}
            disabled={submitting}
          />
        </div>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="ek-input"
            placeholder="juan@correo.com"
            required
            disabled={submitting}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Se enviará una invitación a este email (próximamente con Sprint Stripe).
          </p>
        </div>

        <div className="ek-form-field" style={{ marginBottom: '20px' }}>
          <label className="ek-label" style={{ marginBottom: '10px' }}>Rol</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {(
              [
                {
                  value: 'admin' as const,
                  label: 'Administrador',
                  desc: 'Acceso completo: edita landing, miembros, planes, reglas, equipo. Puede invitar a otros admins.'
                },
                {
                  value: 'recepcionista' as const,
                  label: 'Recepcionista',
                  desc: 'Acceso operativo: check-in de miembros, ver lista del día. No edita configuración.'
                }
              ]
            ).map((opt) => (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '12px',
                  border: `0.5px solid ${rol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                  background: rol === opt.value ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                  borderRadius: 'var(--ek-r-md)',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease'
                }}
              >
                <input
                  type="radio"
                  name="rol"
                  value={opt.value}
                  checked={rol === opt.value}
                  onChange={() => setRol(opt.value)}
                  style={{ marginTop: '3px', accentColor: 'var(--ek-mustard)' }}
                />
                <div>
                  <p
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      margin: 0,
                      marginBottom: '4px',
                      color: rol === opt.value ? 'var(--ek-mustard)' : 'var(--ek-ink)'
                    }}
                  >
                    {opt.label}
                  </p>
                  <p
                    style={{
                      fontSize: '12px',
                      color: 'var(--ek-ink-muted)',
                      margin: 0,
                      lineHeight: 1.5
                    }}
                  >
                    {opt.desc}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <p className="ek-error-text" style={{ marginBottom: '12px' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Cancelar
          </button>
          <button type="submit" disabled={!canSubmit} className="ek-cta" style={{ flex: 1 }}>
            {submitting ? 'Enviando…' : 'Enviar invitación'}
          </button>
        </div>
      </form>
    </div>
  );
}
