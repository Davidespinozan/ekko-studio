import { useState } from 'react';
import { Info } from 'lucide-react';

/**
 * Ícono ⓘ que abre un popover explicando qué mide un KPI, para que el dueño
 * entienda el cálculo sin salir del panel. Click-toggle con backdrop invisible
 * que cierra al tocar fuera (funciona en táctil). Sin librerías ni portal: es
 * posicionamiento absoluto respecto al ícono.
 */
export function InfoTooltip({ titulo, texto }: { titulo: string; texto: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Qué mide ${titulo}`}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '18px',
          height: '18px',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--ek-ink-faint)',
          cursor: 'pointer'
        }}
      >
        <Info size={13} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 41,
              width: 'min(260px, 74vw)',
              padding: '11px 13px',
              background: 'var(--ek-bg-elevated)',
              border: '0.5px solid var(--ek-line-strong)',
              borderRadius: '10px',
              boxShadow: '0 14px 34px -12px rgba(0,0,0,0.7)',
              fontSize: '12px',
              lineHeight: 1.5,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: 'none',
              color: 'var(--ek-ink-muted)',
              whiteSpace: 'normal'
            }}
          >
            {texto}
          </div>
        </>
      )}
    </span>
  );
}
