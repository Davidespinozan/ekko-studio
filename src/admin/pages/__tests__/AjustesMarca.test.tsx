import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * PKG-02A (C02 · F24) — AjustesMarca: si la lectura previa al guardar falla,
 * `current` sería null y el merge escribiría SOLO el draft encima del branding
 * real. Con la lectura fallida NO se ejecuta el update y se avisa en humano.
 */

const h = vi.hoisted(() => ({
  lecturas: 0,
  /** Resultado del SELECT n-ésimo (1 = carga inicial, 2 = lectura previa al guardar). */
  lectura: (_n: number): { data: unknown; error: unknown } => ({ data: { branding: { logo_url_dark: null, color_primary: '#111' } }, error: null }),
  update: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => {
            h.lecturas++;
            return Promise.resolve(h.lectura(h.lecturas));
          }
        })
      }),
      update: (patch: unknown) => {
        h.update(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      }
    })
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', slug: 'ekko', nombre: 'EKKO Studio' }) }));
vi.mock('../../components/ImageUploader', () => ({
  default: (p: { onUploaded: (url: string) => void; currentUrl: string | null }) => (
    <button type="button" onClick={() => p.onUploaded('https://cdn.test/logo.png')}>SUBIR_LOGO</button>
  )
}));

import AjustesMarca from '../AjustesMarca';

const montar = () => render(<ToastProvider><AjustesMarca /></ToastProvider>);

describe('AjustesMarca · guardar (PKG-02A · F24)', () => {
  beforeEach(() => {
    h.lecturas = 0;
    h.update = vi.fn();
    h.lectura = () => ({ data: { branding: { logo_url_dark: null, color_primary: '#111' } }, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('lectura previa OK → el update conserva las demás claves del branding (merge)', async () => {
    montar();
    await waitFor(() => expect(h.lecturas).toBe(1));
    fireEvent.click(screen.getAllByText('SUBIR_LOGO')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    const patch = h.update.mock.calls[0][0] as { branding: Record<string, unknown> };
    expect(patch.branding).toMatchObject({ color_primary: '#111', logo_url_dark: 'https://cdn.test/logo.png' });
  });

  it('la lectura previa FALLA → update NO ejecutado, mensaje humano, sin el error crudo', async () => {
    h.lectura = (n) => (n === 1
      ? { data: { branding: { logo_url_dark: null, color_primary: '#111' } }, error: null }
      : { data: null, error: { message: 'permission denied for table tenants' } });
    montar();
    await waitFor(() => expect(h.lecturas).toBe(1));
    fireEvent.click(screen.getAllByText('SUBIR_LOGO')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.lecturas).toBe(2));
    expect(await screen.findByText(/no se guardó nada/)).toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    // El botón vuelve a quedar disponible para reintentar el guardado.
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).not.toBeDisabled();
  });
});
