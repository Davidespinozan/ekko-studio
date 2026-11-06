import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AccesoLayout, GARANTIAS_ACCESO } from '../AccesoLayout';

/** Fase 2 premium · marco de acceso: panel de marca + formulario como hijos. */
describe('AccesoLayout', () => {
  it('muestra la marca (logo a inicio, bienvenida, garantías) y el contenido del formulario', () => {
    render(
      <MemoryRouter>
        <AccesoLayout><form aria-label="formulario">hola</form></AccesoLayout>
      </MemoryRouter>
    );
    const marca = within(screen.getByTestId('acceso-brand'));
    expect(marca.getByRole('link', { name: 'EKKO Studio, inicio' })).toHaveAttribute('href', '/');
    expect(marca.getByText('Acceso a tu cuenta')).toBeInTheDocument();
    expect(marca.getByRole('heading', { level: 2 })).toHaveTextContent('Bienvenido a EKKO');
    for (const g of GARANTIAS_ACCESO) expect(marca.getByText(g)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'formulario' })).toHaveTextContent('hola');
  });
});
