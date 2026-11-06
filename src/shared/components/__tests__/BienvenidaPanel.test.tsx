import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BienvenidaPanel } from '../BienvenidaPanel';

const TARDE = new Date('2026-11-05T22:00:00Z'); // 15:00 en Mazatlán

/** Bienvenida del panel (patrón Renovacell/Fukuroll): avatar o inicial, rol y fecha, saludo y resumen. */
describe('BienvenidaPanel', () => {
  it('saluda por nombre con la hora del estudio, muestra rol y fecha, y el resumen', () => {
    render(<BienvenidaPanel nombre="david espinoza" rol="admin" resumen="Hoy hay 2 sesiones agendadas." ahora={TARDE} />);
    const panel = screen.getByTestId('bienvenida');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Buenas tardes, David');
    expect(panel).toHaveTextContent('Administración · jueves');
    expect(panel).toHaveTextContent('5 de noviembre');
    expect(screen.getByText('Hoy hay 2 sesiones agendadas.')).toBeInTheDocument();
    expect(panel.querySelector('.ek-hello-av')).toHaveTextContent('D');
    expect(panel.className).not.toContain('ek-hello--urgente');
  });

  it('lo urgente se marca; una cuenta de servicio recibe saludo neutro; con avatar se muestra la foto', () => {
    render(<BienvenidaPanel nombre="recepcion" rol="recepcionista" avatarUrl="https://x/a.png" resumen="Tienes 2 pendientes que requieren tu atención." urgente ahora={TARDE} />);
    const panel = screen.getByTestId('bienvenida');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Buenas tardes$/);
    expect(panel).toHaveTextContent('Recepción ·');
    expect(panel.className).toContain('ek-hello--urgente');
    expect(panel.querySelector('img.ek-hello-av')).toHaveAttribute('src', 'https://x/a.png');
  });
});
