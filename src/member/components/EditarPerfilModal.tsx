import { useState } from 'react';
import { X, UserPen } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';

/**
 * El miembro edita sus datos de contacto (self-serve). Nombre y teléfono son
 * columnas propias de `usuarios` (editables por RLS `usuarios_update_self`). El
 * correo es la identidad de login: se cambia vía Supabase Auth y solo aplica
 * cuando el miembro CONFIRMA el enlace que le llega — el correo actual sigue
 * sirviendo mientras tanto (sin riesgo de quedar afuera). Un trigger propaga el
 * correo confirmado a usuarios.email.
 */
interface Props {
  onClose: () => void;
}

export function EditarPerfilModal({ onClose }: Props) {
  const { usuario, authUser, refreshUsuario } = useAuth();
  const toast = useToast();
  const emailActual = authUser?.email ?? '';

  const [nombre, setNombre] = useState(usuario?.nombre ?? '');
  const [telefono, setTelefono] = useState(usuario?.telefono ?? '');
  const [email, setEmail] = useState(emailActual);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailCambio = email.trim().toLowerCase() !== emailActual.toLowerCase();

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (guardando) return;
    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError('El nombre no puede quedar vacío.');
      return;
    }
    if (emailCambio && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Escribe un correo válido.');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      // Nombre / teléfono → columnas propias (RLS self-update).
      const nuevoTelefono = telefono.trim() || null;
      if (nombreTrim !== (usuario?.nombre ?? '') || nuevoTelefono !== (usuario?.telefono ?? null)) {
        const { error: dbErr } = await supabase
          .from('usuarios')
          .update({ nombre: nombreTrim, telefono: nuevoTelefono })
          .eq('id', usuario!.id);
        if (dbErr) throw new Error(dbErr.message);
      }

      // Correo → Auth (con confirmación). El correo actual sigue vigente hasta
      // confirmar; el trigger sincroniza usuarios.email al confirmarse.
      let avisoEmail = false;
      if (emailCambio) {
        const { error: authErr } = await supabase.auth.updateUser({ email: email.trim() });
        if (authErr) {
          throw new Error(
            /registered|already/i.test(authErr.message)
              ? 'Ese correo ya está en uso.'
              : 'No pudimos cambiar tu correo. Intenta de nuevo.'
          );
        }
        avisoEmail = true;
      }

      await refreshUsuario();
      onClose();
      if (avisoEmail) {
        toast.success(`Te enviamos un correo a ${email.trim()} para confirmar el cambio. Tu correo actual sigue funcionando hasta que lo confirmes.`);
      } else {
        toast.success('¡Datos actualizados!');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos guardar. Intenta de nuevo.');
    } finally {
      setGuardando(false);
    }
  }

  const campo: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    fontSize: '15px',
    color: 'var(--ek-ink)',
    background: 'var(--ek-bg)',
    border: '0.5px solid var(--ek-line-strong)',
    borderRadius: 'var(--ek-r-sm)',
    outline: 'none'
  };
  const label: React.CSSProperties = { display: 'block', fontSize: '13px', color: 'var(--ek-ink-muted)', marginBottom: '6px' };

  return (
    // Solo cierra con el botón ✕ (edición de datos: un clic fuera no debe perderlos).
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <form
        onSubmit={guardar}
        className="ek-card"
        style={{ maxWidth: '440px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard"><UserPen size={12} aria-hidden="true" /> EDITAR PERFIL</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose} disabled={guardando}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="ek-body-muted" style={{ margin: '0 0 18px', fontSize: '14px' }}>
          Actualiza tus datos de contacto.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label htmlFor="ep-nombre" style={label}>Nombre</label>
            <input id="ep-nombre" type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="name" style={campo} />
          </div>
          <div>
            <label htmlFor="ep-tel" style={label}>Teléfono <span style={{ color: 'var(--ek-ink-faint)' }}>(opcional)</span></label>
            <input id="ep-tel" type="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} autoComplete="tel" style={campo} />
          </div>
          <div>
            <label htmlFor="ep-email" style={label}>Correo</label>
            <input id="ep-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={campo} />
            {emailCambio && (
              <p className="ek-helper-text" style={{ marginTop: '6px' }}>
                Te enviaremos un correo de confirmación al nuevo correo. Tu correo actual sigue funcionando hasta que lo confirmes.
              </p>
            )}
          </div>
        </div>

        {error && <p style={{ color: 'var(--ek-danger)', fontSize: '13px', marginTop: '12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold ek-cta--full" disabled={guardando}>
            {guardando ? <Spinner size={16} /> : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}
