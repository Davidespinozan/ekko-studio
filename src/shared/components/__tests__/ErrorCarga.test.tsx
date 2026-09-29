import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorCarga, ErrorInline, HINT_ERROR_CARGA } from '../ErrorCarga';

/**
 * PKG-02A (C02) — los dos componentes con los que la app dice "esto falló":
 * mensaje humano, Reintentar opcional que ejecuta UNA vez el fetch de la
 * pantalla, y ningún dato crudo del error.
 */

describe('ErrorCarga', () => {
  it('muestra el título humano, el hint por defecto y un botón Reintentar que llama una vez', () => {
    const onReintentar = vi.fn();
    render(<ErrorCarga titulo="No pudimos cargar las reservas." onReintentar={onReintentar} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar las reservas.')).toBeInTheDocument();
    expect(screen.getByText(HINT_ERROR_CARGA)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onReintentar).toHaveBeenCalledTimes(1);
  });

  it('sin onReintentar no hay botón; el hint se puede personalizar', () => {
    render(<ErrorCarga titulo="No pudimos cargar la membresía." hint="Reintenta antes de asignar un plan." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Reintenta antes de asignar un plan.')).toBeInTheDocument();
  });

  it('no existe forma de colar un error crudo: solo renderiza lo que la pantalla decide', () => {
    const crudo = 'PGRST301: JWT expired · select * from membresias';
    // El componente no acepta `error`; si alguien pasa el crudo como título es su
    // decisión (y los tests de pantalla lo impiden). Aquí: lo que NO se pasa, no sale.
    render(<ErrorCarga titulo="No pudimos cargar." />);
    expect(screen.queryByText(new RegExp(crudo))).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PGRST|JWT|select \*/);
  });
});

describe('ErrorInline', () => {
  it('muestra el mensaje y reintenta al tocar', () => {
    const onReintentar = vi.fn();
    render(<ErrorInline mensaje="No pudimos actualizar la lista." onReintentar={onReintentar} />);
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos actualizar la lista.');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onReintentar).toHaveBeenCalledTimes(1);
  });

  it('sin onReintentar es solo el aviso', () => {
    render(<ErrorInline mensaje="Membresías no disponibles." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
