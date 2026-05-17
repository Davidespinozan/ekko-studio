import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import Toggle from '../components/Toggle';

type FieldType = 'string' | 'number' | 'boolean' | 'json';

function inferirTipo(valor: unknown): FieldType {
  if (typeof valor === 'boolean') return 'boolean';
  if (typeof valor === 'number') return 'number';
  if (typeof valor === 'string') return 'string';
  return 'json';
}

function formatearLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function AutoForm({
  data,
  onChange
}: {
  data: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const updateField = (key: string, valor: unknown) => {
    onChange({ ...data, [key]: valor });
  };

  const entries = Object.entries(data ?? {});

  if (entries.length === 0) {
    return <p className="ek-body-faint">No hay configuración guardada todavía.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {entries.map(([key, valor]) => {
        const tipo = inferirTipo(valor);
        const label = formatearLabel(key);

        if (tipo === 'boolean') {
          return (
            <div key={key}>
              <Toggle
                checked={valor as boolean}
                onChange={(v) => updateField(key, v)}
                label={label}
              />
            </div>
          );
        }

        if (tipo === 'number') {
          return (
            <div key={key} className="ek-form-field">
              <label className="ek-label">{label}</label>
              <input
                type="number"
                value={valor as number}
                onChange={(e) => updateField(key, parseFloat(e.target.value) || 0)}
                className="ek-input"
              />
            </div>
          );
        }

        if (tipo === 'string') {
          return (
            <div key={key} className="ek-form-field">
              <label className="ek-label">{label}</label>
              <input
                type="text"
                value={valor as string}
                onChange={(e) => updateField(key, e.target.value)}
                className="ek-input"
              />
            </div>
          );
        }

        return (
          <div key={key} className="ek-form-field">
            <label className="ek-label">
              {label}{' '}
              <span style={{ color: 'var(--ek-ink-faint)' }}>(estructura compleja)</span>
            </label>
            <textarea
              defaultValue={JSON.stringify(valor, null, 2)}
              onBlur={(e) => {
                try {
                  updateField(key, JSON.parse(e.target.value));
                } catch {
                  // mantiene texto sin commit si JSON inválido
                }
              }}
              className="ek-input"
              style={{
                minHeight: '120px',
                fontFamily: 'var(--ek-font-mono)',
                fontSize: '12px'
              }}
            />
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
              Este campo es complejo y aún requiere edición en formato JSON. El cambio se
              aplica al perder el foco.
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function Configuracion() {
  const tenant = useTenant();
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [branding, setBranding] = useState<Record<string, unknown>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: 'success' | 'error'; texto: string } | null>(
    null
  );

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('tenants')
        .select('config, branding')
        .eq('id', tenant.id)
        .single();

      if (error) {
        console.error('[Configuracion]', error);
      } else if (data) {
        setConfig((data.config as Record<string, unknown>) ?? {});
        setBranding((data.branding as Record<string, unknown>) ?? {});
      }
      setIsLoading(false);
    }
    load();
  }, [tenant.id]);

  const guardar = async () => {
    setIsSaving(true);
    setMensaje(null);

    const { error } = await supabase
      .from('tenants')
      .update({ config: config as never, branding: branding as never })
      .eq('id', tenant.id);

    if (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } else {
      setMensaje({ tipo: 'success', texto: 'Configuración guardada.' });
    }
    setIsSaving(false);
  };

  if (isLoading) {
    return (
      <div>
        <div
          className="ek-skeleton"
          style={{ height: '40px', width: '200px', marginBottom: '16px' }}
        />
        <div className="ek-skeleton" style={{ height: '300px' }} />
      </div>
    );
  }

  return (
    <div>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>AJUSTES</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '32px'
        }}
      >
        Configuración
      </h1>

      <section className="ek-card" style={{ marginBottom: '24px', padding: '28px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          REGLAS DE OPERACIÓN
        </p>
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '20px',
            letterSpacing: '-0.02em'
          }}
        >
          Configuración del negocio
        </h2>
        <AutoForm data={config} onChange={setConfig} />
      </section>

      <section className="ek-card" style={{ marginBottom: '24px', padding: '28px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
          BRANDING
        </p>
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '20px',
            letterSpacing: '-0.02em'
          }}
        >
          Identidad visual
        </h2>
        <AutoForm data={branding} onChange={setBranding} />
      </section>

      {mensaje && (
        <div
          style={{
            padding: '14px 18px',
            marginBottom: '20px',
            borderRadius: 'var(--ek-r-md)',
            background:
              mensaje.tipo === 'success' ? 'var(--ek-success-soft)' : 'var(--ek-danger-soft)',
            color: mensaje.tipo === 'success' ? 'var(--ek-success)' : 'var(--ek-danger)',
            fontSize: '13px',
            fontWeight: 500
          }}
        >
          {mensaje.texto}
        </div>
      )}

      <button
        onClick={guardar}
        disabled={isSaving}
        className="ek-cta"
        style={{ padding: '14px 28px', fontSize: '14px' }}
      >
        {isSaving ? 'Guardando…' : 'Guardar cambios'}
      </button>
    </div>
  );
}
