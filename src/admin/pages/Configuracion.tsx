import { useState } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';

export default function Configuracion() {
  const tenant = useTenant();
  const [configJSON, setConfigJSON] = useState(JSON.stringify(tenant.config, null, 2));
  const [brandingJSON, setBrandingJSON] = useState(JSON.stringify(tenant.branding, null, 2));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function handleSaveConfig() {
    setSaving(true);
    setMessage(null);
    try {
      const parsed = JSON.parse(configJSON);
      const { error } = await supabase.from('tenants').update({ config: parsed }).eq('id', tenant.id);
      if (error) throw error;
      setMessage({ kind: 'ok', text: 'Config guardado. Recarga la página para que se apliquen los cambios.' });
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : 'JSON inválido' });
    }
    setSaving(false);
  }

  async function handleSaveBranding() {
    setSaving(true);
    setMessage(null);
    try {
      const parsed = JSON.parse(brandingJSON);
      const { error } = await supabase.from('tenants').update({ branding: parsed }).eq('id', tenant.id);
      if (error) throw error;
      setMessage({ kind: 'ok', text: 'Branding guardado. Recarga la página.' });
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : 'JSON inválido' });
    }
    setSaving(false);
  }

  return (
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">CONFIGURACIÓN</p>
        <h1 className="ek-h2">Reglas del negocio</h1>
      </div>

      <section className="adm-section">
        <h2 className="ek-h3">Reglas de reserva</h2>
        <p className="adm-body" style={{ marginBottom: '0.75rem' }}>
          JSON editable. Cambia las reglas como duración de slot, anticipación,
          si se permiten reservas continuas, etc.
        </p>
        <textarea
          value={configJSON}
          onChange={(e) => setConfigJSON(e.target.value)}
          className="ek-input"
          rows={20}
          style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '0.8125rem' }}
        />
        <button onClick={handleSaveConfig} disabled={saving} className="ek-cta" style={{ marginTop: '0.75rem' }}>
          {saving ? 'Guardando…' : 'Guardar config'}
        </button>
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Branding</h2>
        <p className="adm-body" style={{ marginBottom: '0.75rem' }}>
          Colores y logo del tenant. Se aplican al cargar la app.
        </p>
        <textarea
          value={brandingJSON}
          onChange={(e) => setBrandingJSON(e.target.value)}
          className="ek-input"
          rows={12}
          style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '0.8125rem' }}
        />
        <button onClick={handleSaveBranding} disabled={saving} className="ek-cta" style={{ marginTop: '0.75rem' }}>
          {saving ? 'Guardando…' : 'Guardar branding'}
        </button>
      </section>

      {message && (
        <p style={{
          marginTop: '1rem',
          padding: '0.75rem 1rem',
          borderRadius: 'var(--ek-radius)',
          background: message.kind === 'ok' ? '#E0F0E5' : '#F8DCDC',
          color: message.kind === 'ok' ? 'var(--ek-success)' : 'var(--ek-danger)',
          fontSize: '0.875rem'
        }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
