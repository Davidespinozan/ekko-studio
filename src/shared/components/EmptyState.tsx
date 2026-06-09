import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** Botón/acción opcional debajo del texto. */
  action?: ReactNode;
  tone?: 'accent' | 'neutral' | 'danger';
}

/**
 * Empty/error state premium (técnica #10): icono vectorial en círculo
 * tintado + título + ayuda + acción. Reemplaza los `<p>Sin resultados.</p>`
 * y emojis sueltos repartidos por la app.
 */
export function EmptyState({ icon: Icon, title, hint, action, tone = 'accent' }: EmptyStateProps) {
  const toneClass =
    tone === 'neutral' ? 'ek-empty-icon--neutral' : tone === 'danger' ? 'ek-empty-icon--danger' : '';
  return (
    <div className="ek-empty">
      <div className={`ek-empty-icon ${toneClass}`}>
        <Icon size={26} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="ek-empty-title">{title}</div>
      {hint && <p className="ek-empty-hint">{hint}</p>}
      {action && <div style={{ marginTop: 20 }}>{action}</div>}
    </div>
  );
}
