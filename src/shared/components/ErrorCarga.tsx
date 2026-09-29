import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { EmptyState } from './EmptyState';

/**
 * PKG-02A · Estados de error HONESTOS (C02): un fallo técnico nunca se pinta
 * como "no hay datos". Estos dos componentes son la única forma de mostrar un
 * error de lectura en la app; reutilizan EmptyState y los botones existentes.
 *
 * Reglas:
 *  - Reciben un título/mensaje HUMANO decidido por la pantalla. Jamás un
 *    `error.message` de Supabase/Stripe, SQL, códigos ni ids.
 *  - "Reintentar" solo vuelve a ejecutar el fetch de la pantalla (sin retries
 *    automáticos ni backoff).
 *
 * EMPTY ≠ ERROR ≠ LOADING ≠ STALE.
 */

export const HINT_ERROR_CARGA = 'Revisa tu conexión e intenta de nuevo.';

interface ErrorCargaProps {
  /** Qué no se pudo cargar, en humano: "No pudimos cargar las reservas." */
  titulo: string;
  hint?: string;
  icon?: LucideIcon;
  /** Vuelve a ejecutar el fetch. Si no se pasa, no hay botón. */
  onReintentar?: () => void;
  etiquetaReintentar?: string;
}

/** Bloque completo (sustituye a la lista/tarjeta cuando NO hay dato previo). */
export function ErrorCarga({ titulo, hint = HINT_ERROR_CARGA, icon = AlertTriangle, onReintentar, etiquetaReintentar = 'Reintentar' }: ErrorCargaProps) {
  return (
    <div data-testid="error-carga" role="alert">
      <EmptyState
        icon={icon}
        title={titulo}
        hint={hint}
        tone="danger"
        action={
          onReintentar ? (
            <button type="button" className="ek-cta" style={{ minHeight: '44px' }} onClick={onReintentar}>
              {etiquetaReintentar}
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

interface ErrorInlineProps {
  /** "No pudimos actualizar la lista." */
  mensaje: string;
  onReintentar?: () => void;
  etiquetaReintentar?: string;
}

/**
 * Aviso compacto para tarjetas/KPIs o para marcar datos STALE (hay dato previo
 * pero la última actualización falló): el dato se conserva y esto lo dice.
 */
export function ErrorInline({ mensaje, onReintentar, etiquetaReintentar = 'Reintentar' }: ErrorInlineProps) {
  return (
    <div
      data-testid="error-inline"
      role="alert"
      style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 12px', borderRadius: 'var(--ek-r-md)', background: 'var(--ek-danger-soft)' }}
    >
      <AlertTriangle size={15} aria-hidden="true" style={{ color: 'var(--ek-danger)', flexShrink: 0 }} />
      <span className="ek-error-text" style={{ flex: 1, minWidth: 0 }}>{mensaje}</span>
      {onReintentar && (
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px', padding: '6px 12px', fontSize: '12px' }} onClick={onReintentar}>
          {etiquetaReintentar}
        </button>
      )}
    </div>
  );
}
