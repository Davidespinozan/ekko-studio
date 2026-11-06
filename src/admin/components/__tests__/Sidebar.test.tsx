import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * EKKO-149 · Pie del menú del admin: "Operado por STRYV" es la entrada a los
 * planes STRYV (/admin/stryv), como en Fukuroll y Renovacell. No es una entrada
 * más de la navegación: vive en el pie, debajo de la sesión.
 */

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ usuario: { nombre: 'ana lópez', email: 'ana@ekko.test', rol: 'admin', status: 'activo' }, signOut: vi.fn() })
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ nombre: 'EKKO Studio', branding: {} }) }));

import { Sidebar } from '../Sidebar';

const montar = (ruta = '/admin') => render(<MemoryRouter initialEntries={[ruta]}><Sidebar /></MemoryRouter>);

describe('Sidebar · Operado por STRYV', () => {
  it('el pie lleva a los planes STRYV', () => {
    montar();
    const a = screen.getByTestId('side-stryv');
    expect(a).toHaveAttribute('href', '/admin/stryv');
    expect(a).toHaveTextContent('Operado por STRYV');
    expect(a).toHaveTextContent('Ver mis planes STRYV');
    expect(a.className).not.toContain('adm-sidebar-stryv--active');
    // No es una sección del menú: no hay entrada "STRYV Care" entre los NavLink de las secciones.
    expect(screen.queryByRole('link', { name: 'STRYV Care' })).toBeNull();
  });

  it('en /admin/stryv el pie se marca activo', () => {
    montar('/admin/stryv');
    expect(screen.getByTestId('side-stryv').className).toContain('adm-sidebar-stryv--active');
  });

  it('la sesión y "Cerrar sesión" siguen en el pie', () => {
    montar();
    expect(screen.getByText('Ana López')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cerrar sesión/ })).toBeInTheDocument();
  });
});
