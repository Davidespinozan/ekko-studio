import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  onRetry: () => void | Promise<void>;
  que?: string;
}

/**
 * La carga de la configuración actual falló: guardar encima borraría lo que no
 * se pudo leer (contacto, landing, reglas, marca…). Se bloquea Guardar y se
 * ofrece reintentar. (Lección de SALA f4785c2.)
 */
export function ConfigLoadErrorBanner({ onRetry, que = 'la configuración actual' }: Props) {
  return (
    <div
      role="alert"
      className="ek-card"
      style={{
        display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', marginBottom: '16px',
        border: '1px solid var(--ek-danger)', background: 'rgba(226,85,85,0.08)'
      }}
    >
      <AlertTriangle size={18} aria-hidden="true" style={{ color: 'var(--ek-danger)', flexShrink: 0 }} />
      <p style={{ margin: 0, flex: 1, fontSize: '13px' }}>
        No pudimos cargar {que}. Para no pisar lo que ya tienes guardado, el botón Guardar queda
        deshabilitado hasta que se recargue.
      </p>
      <button type="button" onClick={() => void onRetry()} className="ek-cta ek-cta--secondary" style={{ minHeight: '36px', display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
        <RefreshCw size={14} aria-hidden="true" /> Reintentar
      </button>
    </div>
  );
}
