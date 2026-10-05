import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { CambiarPasswordForm } from '@shared/components/CambiarPasswordForm';

export const TIPO_NOTIF_CAMBIAR_PASSWORD = 'cambiar_password';

/**
 * Aviso EN PANTALLA para que el dueño de la cuenta cambie la contraseña
 * TEMPORAL que le dictó recepción/admin (alta o reset). Se dispara con la
 * notificación `cambiar_password` que insertan esas funciones. PKG-02C: el aviso
 * lo cierra el SERVIDOR cuando la contraseña cambia de verdad (trigger en
 * auth.users); este componente solo vuelve a consultar. Si el aviso sigue
 * abierto, el gate sigue en pantalla: nunca se oculta por decisión del cliente.
 * "Ahora no" deja seguir usando la app, pero vuelve
 * en la siguiente entrada. Montado en los 3 layouts (miembro, admin, recepción):
 * en EKKO la cuenta tiene tarjeta guardada, créditos y reservas de equipo caro —
 * una clave dictada por un tercero no puede quedarse como definitiva.
 */
export function CambiarPasswordGate() {
  const { usuario } = useAuth();
  const usuarioId = usuario?.id ?? null;
  const [avisoId, setAvisoId] = useState<string | null>(null);
  const [pospuesto, setPospuesto] = useState(false);

  // Depende del id (estable), no del objeto usuario: una rehidratación del
  // perfil no debe volver a consultar ni reabrir el modal recién cerrado.
  const buscar = useCallback(async () => {
    if (!usuarioId) {
      setAvisoId(null);
      return;
    }
    const { data, error } = await supabase
      .from('notificaciones')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('tipo', TIPO_NOTIF_CAMBIAR_PASSWORD)
      .eq('leida', false)
      .order('creada_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[CambiarPasswordGate]', error);
      return;
    }
    setAvisoId(data?.id ?? null);
  }, [usuarioId]);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  if (!avisoId || pospuesto) return null;

  async function alCambiar() {
    // El servidor marca el aviso al cambiar la contraseña; aquí solo se observa.
    await buscar();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cpg-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        background: 'rgba(20, 8, 8, 0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)'
      }}
    >
      <div
        className="ek-card"
        style={{
          width: '100%', maxWidth: '420px', padding: '28px 24px',
          border: '1px solid var(--ek-danger)',
          boxShadow: '0 0 0 4px rgba(220,38,38,0.15), 0 20px 60px rgba(0,0,0,0.4)'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: '18px' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex', width: 52, height: 52, borderRadius: '14px',
              alignItems: 'center', justifyContent: 'center', marginBottom: '14px',
              background: 'rgba(220,38,38,0.12)', color: 'var(--ek-danger)'
            }}
          >
            <ShieldAlert size={26} strokeWidth={2.25} />
          </span>
          <p style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.14em', color: 'var(--ek-danger)', margin: 0 }}>
            IMPORTANTE · SEGURIDAD
          </p>
          <h2 id="cpg-title" style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', margin: '6px 0 8px' }}>
            Cambia tu contraseña ahora
          </h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Entraste con una contraseña <strong>temporal</strong> que te dieron en el estudio.
            Cámbiala por una <strong>tuya</strong> para que nadie más pueda entrar a tu cuenta.
          </p>
        </div>

        <CambiarPasswordForm onSuccess={alCambiar} ctaLabel="Guardar mi contraseña" autoFocus />

        <button
          type="button"
          onClick={() => setPospuesto(true)}
          style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12.5px', color: 'var(--ek-ink-faint)', marginTop: '12px' }}
        >
          Ahora no (te lo recordaremos)
        </button>
      </div>
    </div>
  );
}
