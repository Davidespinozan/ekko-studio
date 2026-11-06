import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LoadingScreen, LOGO_LOADER } from '../LoadingScreen';

/**
 * Pantalla de carga (como en SALA): isotipo + anillo. El componente y el splash
 * de index.html comparten clases y hoja (public/loader.css), para que el primer
 * paint y las cargas posteriores se vean iguales.
 */
describe('LoadingScreen', () => {
  it('muestra el isotipo con el anillo y un texto accesible', () => {
    render(<LoadingScreen />);
    const status = screen.getByRole('status', { name: 'Cargando…' });
    expect(status.querySelector('.ek-loader-ring')).not.toBeNull();
    const logo = status.querySelector('img.ek-loader-logo');
    expect(logo).toHaveAttribute('src', LOGO_LOADER);
    expect(logo).toHaveAttribute('alt', '');
    expect(screen.getByText('Cargando…')).toBeInTheDocument();
  });

  it('admite otro texto', () => {
    render(<LoadingScreen label="Verificando tu sesión…" />);
    expect(screen.getByRole('status', { name: 'Verificando tu sesión…' })).toBeInTheDocument();
  });

  it('index.html trae el mismo splash (hoja en public/, sin <style> ni scripts inline) y el ícono existe', () => {
    const raiz = resolve(__dirname, '../../../..');
    const html = readFileSync(resolve(raiz, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="/loader.css" />');
    expect(html).toMatch(/<div id="root">[\s\S]*class="ek-loader"[\s\S]*class="ek-loader-ring"[\s\S]*class="ek-loader-logo" src="\/icons\/icon-192\.png"/);
    expect(html).not.toMatch(/<style\b/);
    const hoja = readFileSync(resolve(raiz, 'public/loader.css'), 'utf8');
    for (const clase of ['.ek-loader', '.ek-loader-mark', '.ek-loader-ring', '.ek-loader-logo', '.ek-loader-label']) expect(hoja).toContain(clase);
    expect(hoja).toContain('prefers-reduced-motion');
    expect(() => readFileSync(resolve(raiz, 'public', LOGO_LOADER.slice(1)))).not.toThrow();
  });
});
