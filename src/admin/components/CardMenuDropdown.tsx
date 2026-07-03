import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface DropdownItem {
  label: string;
  /** Icono Lucide (preferido) o glifo string (compatibilidad legacy). */
  icon: LucideIcon | string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renderiza un separador horizontal antes de este item. */
  divider?: boolean;
}

interface Props {
  items: DropdownItem[];
}

/**
 * Menú "⋯" reusable para cards de admin (Recursos, Tiers, Equipo).
 * Click fuera cierra. Selección cierra y ejecuta acción.
 * stopPropagation: el menú no propaga clicks al card padre.
 */
export default function CardMenuDropdown({ items }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Posiciona el menú con coordenadas de viewport (fixed): así NINGÚN contenedor
  // con overflow lo corta, y abre hacia arriba si no hay espacio abajo.
  function abrir() {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const estAlto = items.length * 46 + 16;
    const espacioAbajo = window.innerHeight - r.bottom;
    const abrirArriba = espacioAbajo < estAlto + 12 && r.top > espacioAbajo;
    setPos({
      right: Math.max(8, window.innerWidth - r.right),
      top: abrirArriba ? Math.max(8, r.top - estAlto - 4) : r.bottom + 4
    });
    setOpen(true);
  }

  // Cerrar al hacer scroll/resize (si no, el menú fixed quedaría "flotando").
  useEffect(() => {
    if (!open) return;
    const cerrar = () => setOpen(false);
    window.addEventListener('scroll', cerrar, true);
    window.addEventListener('resize', cerrar);
    return () => {
      window.removeEventListener('scroll', cerrar, true);
      window.removeEventListener('resize', cerrar);
    };
  }, [open]);

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else abrir();
        }}
        className="ek-icon-btn"
        aria-label="Acciones"
        aria-expanded={open}
        style={{ width: '44px', height: '44px', padding: 0, lineHeight: 1 }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && pos && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            style={{
              position: 'fixed',
              top: pos.top,
              right: pos.right,
              minWidth: '220px',
              background: 'var(--ek-bg-elevated)',
              border: '0.5px solid var(--ek-line-strong)',
              borderRadius: '12px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
              padding: '6px',
              zIndex: 50,
              animation: 'ek-fade-in 0.12s ease'
            }}
            role="menu"
          >
            {items.map((item, idx) => {
              const Icon = typeof item.icon === 'string' ? null : item.icon;
              return (
              <div key={`${item.label}-${idx}`}>
                {item.divider && (
                  <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '4px 0' }} />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!item.disabled) item.onClick();
                  }}
                  disabled={item.disabled}
                  role="menuitem"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    minHeight: '44px',
                    padding: '10px 12px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: '8px',
                    color: item.danger ? 'var(--ek-danger)' : 'var(--ek-ink)',
                    fontSize: '13px',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    cursor: item.disabled ? 'not-allowed' : 'pointer',
                    opacity: item.disabled ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (!item.disabled) e.currentTarget.style.background = 'var(--ek-bg-elevated)';
                  }}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {Icon ? (
                    <Icon size={16} aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true">{item.icon as string}</span>
                  )}
                  {item.label}
                </button>
              </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
