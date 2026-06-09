import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  /** Texto a copiar al portapapeles. */
  text: string;
  /** Etiqueta en reposo. */
  label?: string;
  /** Etiqueta tras copiar. */
  copiedLabel?: string;
  className?: string;
  full?: boolean;
}

/**
 * Botón de copiar unificado (técnica #2/#7): icono Lucide + feedback de
 * estado. Reemplaza los `{copiado ? '✓ Copiado' : '📋 Copiar'}` repetidos.
 */
export function CopyButton({
  text,
  label = 'Copiar',
  copiedLabel = 'Copiado',
  className,
  full
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard no disponible — silencioso */
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`ek-cta ek-cta--secondary ${full ? 'ek-cta--full' : ''} ${className ?? ''}`}
      aria-label={label}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {copied ? copiedLabel : label}
    </button>
  );
}
