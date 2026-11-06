import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Fase 1 premium · Navegación flotante de la landing: enlaces a las secciones,
 * acciones según la sesión, sólida al hacer scroll y hamburguesa en teléfono.
 */

const h = vi.hoisted(() => ({ authUser: null as { id: string } | null, signOut: vi.fn(async () => {}) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ authUser: h.authUser, signOut: h.signOut }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ nombre: 'EKKO Studio', branding: {} }) }));

import { LandingNav, ENLACES_LANDING } from '../LandingNav';

const montar = () => render(<MemoryRouter><LandingNav /></MemoryRouter>);

beforeEach(() => {
  h.authUser = null;
  h.signOut = vi.fn(async () => {});
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
});

describe('LandingNav', () => {
  it('sin sesión: enlaces a las secciones, "Iniciar sesión" y "Ver planes"', () => {
    montar();
    for (const [href, texto] of ENLACES_LANDING) {
      expect(screen.getByRole('link', { name: texto })).toHaveAttribute('href', href);
    }
    expect(screen.getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Ver planes' })).toHaveAttribute('href', '#membresias');
    expect(screen.queryByText('Mi cuenta')).toBeNull();
  });

  it('con sesión: "Mi cuenta" lleva a la app y "Salir" cierra la sesión', () => {
    h.authUser = { id: 'u1' };
    montar();
    expect(screen.getByRole('link', { name: 'Mi cuenta' })).toHaveAttribute('href', '/app');
    fireEvent.click(screen.getByRole('button', { name: 'Salir' }));
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Iniciar sesión')).toBeNull();
  });

  it('transparente arriba; sólida al hacer scroll', () => {
    montar();
    const nav = screen.getByTestId('landing-nav');
    expect(nav.className).not.toContain('ek-nav--solid');
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: 120, writable: true, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    expect(nav.className).toContain('ek-nav--solid');
  });

  it('la hamburguesa abre y cierra el menú, y un enlace lo cierra', () => {
    montar();
    const burger = screen.getByRole('button', { name: 'Abrir menú' });
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(burger);
    expect(screen.getByTestId('landing-nav').className).toContain('ek-nav--open');
    expect(screen.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('link', { name: 'Planes' }));
    expect(screen.getByTestId('landing-nav').className).not.toContain('ek-nav--open');
  });
});
