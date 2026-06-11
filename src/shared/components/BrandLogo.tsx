import type { CSSProperties } from 'react';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Logo del estudio. Resuelve la URL desde `tenant.branding`
 * (logo_url_dark → logo_url) con fallback al logo oficial de EKKO — el mismo
 * que usan el landing, el login y el footer. Evita que member/recepción caigan
 * a texto plano (bug: "no tienen los logos correctamente").
 */

const EKKO_LOGO_FALLBACK =
  'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png';

export function brandLogoUrl(branding: unknown): string {
  const b = (branding ?? {}) as Record<string, unknown>;
  if (typeof b.logo_url_dark === 'string' && b.logo_url_dark) return b.logo_url_dark;
  if (typeof b.logo_url === 'string' && b.logo_url) return b.logo_url;
  return EKKO_LOGO_FALLBACK;
}

interface Props {
  height?: number;
  maxWidth?: number;
  style?: CSSProperties;
}

export function BrandLogo({ height = 38, maxWidth = 150, style }: Props) {
  const tenant = useTenant();
  return (
    <img
      src={brandLogoUrl(tenant.branding)}
      alt={tenant.nombre ?? 'EKKO Studio'}
      style={{ height, width: 'auto', maxWidth, objectFit: 'contain', display: 'block', ...style }}
    />
  );
}
