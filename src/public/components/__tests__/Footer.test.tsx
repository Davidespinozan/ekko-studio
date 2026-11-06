import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * EKKO-149 · Pie de la landing: pill "Operado por STRYV" → stryvstudio.com (mismo
 * diseño que el menú de Fukuroll y la landing de Renovacell). Es fijo: no sale del
 * editor de la landing, y el © del estudio sigue ahí.
 */

vi.mock('@shared/hooks/useLandingConfig', () => ({
  useLandingConfig: () => ({
    footer: { tagline: '', copyright: 'Todos los derechos reservados.', direccion: null, email: null, redes: { instagram: null, tiktok: null, youtube: null, facebook: null } }
  })
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ nombre: 'EKKO Studio', branding: {} }) }));

import Footer from '../Footer';

describe('Footer · Operado por STRYV', () => {
  it('la pill enlaza a stryvstudio.com en pestaña nueva y sin referrer', () => {
    render(<Footer />);
    const a = screen.getByRole('link', { name: 'Operado por STRYV · stryvstudio.com' });
    expect(a).toHaveAttribute('href', 'https://stryvstudio.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a).toHaveTextContent('Operado por STRYV');
  });

  it('el © del estudio se conserva junto a la pill', () => {
    render(<Footer />);
    expect(screen.getByText(new RegExp(`© ${new Date().getFullYear()} EKKO Studio\\. Todos los derechos reservados\\.`))).toBeInTheDocument();
  });
});
