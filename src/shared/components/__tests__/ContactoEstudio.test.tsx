import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock('@shared/providers/TenantProvider', () => ({ useTenantOpcional: () => ({ id: 't-1', config: h.config }) }));

import { ContactoEstudio } from '../ContactoEstudio';

describe('ContactoEstudio (A12)', () => {
  it('con WhatsApp configurado abre el chat con el mensaje prellenado', () => {
    h.config = { contacto: { whatsapp_e164: '5216671234567', whatsapp_mensaje_default: 'Hola' } };
    render(<ContactoEstudio mensaje="Hola, mi cuenta está suspendida" />);
    const a = screen.getByRole('link', { name: /escríbele al estudio/i });
    expect(a).toHaveAttribute('href', 'https://wa.me/5216671234567?text=Hola%2C%20mi%20cuenta%20est%C3%A1%20suspendida');
    expect(a).toHaveAttribute('target', '_blank');
  });

  it('sin mensaje usa el del estudio', () => {
    h.config = { contacto: { whatsapp_e164: '5216671234567', whatsapp_mensaje_default: 'Hola EKKO' } };
    render(<ContactoEstudio etiqueta="Contactar" enLinea />);
    expect(screen.getByRole('link', { name: 'Contactar' })).toHaveAttribute('href', 'https://wa.me/5216671234567?text=Hola%20EKKO');
  });

  it('sin número configurado no pinta nada (nada de botones muertos)', () => {
    h.config = {};
    const { container } = render(<ContactoEstudio />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sin TenantProvider (tenant null) tampoco truena', () => {
    h.config = {};
    const { container } = render(<ContactoEstudio />);
    expect(container).toBeEmptyDOMElement();
  });
});
