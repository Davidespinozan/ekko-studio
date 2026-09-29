import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MembresiaCard } from '../perfil/MembresiaCard';

/**
 * PKG-02A (C02 · F03/F05) — la tarjeta de membresía (recepción y admin):
 * error de lectura ≠ "SIN MEMBRESÍA". Con error no se ofrece ninguna acción
 * basada en la ausencia (asignar/renovar/dar de baja).
 */

describe('MembresiaCard (PKG-02A)', () => {
  it('success sin membresía → "SIN MEMBRESÍA" + "Asignar plan" (ausencia real)', () => {
    render(<MembresiaCard membresia={null} cargando={false} onAccion={vi.fn()} />);
    expect(screen.getByText('SIN MEMBRESÍA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /asignar plan/i })).toBeInTheDocument();
  });

  it('error → "No pudimos cargar la membresía" + Reintentar; NI "SIN MEMBRESÍA" NI acciones', () => {
    const onAccion = vi.fn();
    const onReintentar = vi.fn();
    render(<MembresiaCard membresia={null} cargando={false} error onReintentar={onReintentar} onAccion={onAccion} />);
    expect(screen.getByText('No pudimos cargar la membresía.')).toBeInTheDocument();
    expect(screen.queryByText('SIN MEMBRESÍA')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /asignar|renovar|cambiar|pausar|reanudar|ajustar|baja/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onReintentar).toHaveBeenCalledTimes(1);
    expect(onAccion).not.toHaveBeenCalled();
  });

  it('cargando → skeleton, sin etiqueta ni acciones', () => {
    render(<MembresiaCard membresia={null} cargando onAccion={vi.fn()} />);
    expect(screen.queryByText('SIN MEMBRESÍA')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('error con membresía previa conocida → también muestra el error (no decide con dato viejo)', () => {
    const viva = { id: 'm1', status: 'activa', periodo_actual_fin: null, creditos_restantes: 2, stripe_subscription_id: null, cancel_at_period_end: false, created_at: '2026-01-01', tier: { slug: 'starter', nombre: 'Starter', tipo: 'hibrido' } };
    render(<MembresiaCard membresia={viva} cargando={false} error onAccion={vi.fn()} />);
    expect(screen.getByText('No pudimos cargar la membresía.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dar de baja|ajustar/i })).not.toBeInTheDocument();
  });
});
