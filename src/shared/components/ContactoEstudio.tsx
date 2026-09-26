import type { CSSProperties } from 'react';
import { MessageCircle } from 'lucide-react';
import { useTenantOpcional } from '@shared/providers/TenantProvider';
import { whatsappUrlDe } from '@shared/hooks/useLandingConfig';

interface Props {
  /** Texto prellenado del WhatsApp (por defecto el del estudio). */
  mensaje?: string;
  etiqueta?: string;
  style?: CSSProperties;
  /** Enlace de texto en vez de botón (para meterlo dentro de un párrafo). */
  enLinea?: boolean;
}

/**
 * "Contacta al estudio" con enlace de verdad (A12 de la paridad SALA).
 * Nueve pantallas decían "contacta al estudio" sin decir cómo. Si el estudio
 * tiene WhatsApp configurado (`config.contacto.whatsapp_e164`) se abre el chat
 * con el mensaje ya escrito; si no hay número (o no hay tenant todavía), no se
 * pinta nada (mejor que un botón muerto).
 */
export function ContactoEstudio({ mensaje, etiqueta = 'Escríbele al estudio', style, enLinea = false }: Props) {
  const tenant = useTenantOpcional();
  const href = whatsappUrlDe(tenant?.config, mensaje);
  if (!href) return null;
  if (enLinea) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ek-mustard)', textDecoration: 'underline', fontWeight: 500, ...style }}>
        {etiqueta}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ek-cta ek-cta--secondary" style={{ minHeight: '44px', fontSize: '13px', ...style }}>
      <MessageCircle size={15} aria-hidden="true" /> {etiqueta}
    </a>
  );
}
