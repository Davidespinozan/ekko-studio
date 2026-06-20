import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppShowcase from '../AppShowcase';

describe('AppShowcase', () => {
  it('renderiza el titular y el subtítulo de la sección', () => {
    render(
      <MemoryRouter>
        <AppShowcase />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: /lleva tu estudio/i })).toBeInTheDocument();
    expect(screen.getByText(/se instala desde el navegador/i)).toBeInTheDocument();
  });

  it('el CTA "Abrir la app" apunta a /app', () => {
    render(
      <MemoryRouter>
        <AppShowcase />
      </MemoryRouter>
    );
    const cta = screen.getByRole('link', { name: /abrir la app/i });
    expect(cta).toHaveAttribute('href', '/app');
  });
});
