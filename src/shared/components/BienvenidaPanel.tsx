import type { ReactNode } from 'react';
import { etiquetaRol, fechaLarga, inicialDe, nombrePersona, saludo } from '@shared/lib/bienvenida';

/**
 * Bienvenida del panel (admin y recepción), como en Renovacell y Fukuroll: avatar
 * o inicial, rol con la fecha del estudio, saludo según la hora y un resumen del
 * día en una línea (en mostaza cuando hay algo pendiente). Abre siempre el Inicio.
 */
interface Props {
  nombre?: string | null;
  rol?: string | null;
  avatarUrl?: string | null;
  resumen: string;
  urgente?: boolean;
  /** Inyectable en pruebas (la hora se toma en la zona del estudio). */
  ahora?: Date;
  children?: ReactNode;
}

export function BienvenidaPanel({ nombre, rol, avatarUrl, resumen, urgente = false, ahora, children }: Props) {
  const persona = nombrePersona(nombre);
  return (
    <header className={`ek-hello${urgente ? ' ek-hello--urgente' : ''}`} data-testid="bienvenida">
      {avatarUrl ? (
        <img className="ek-hello-av" src={avatarUrl} alt="" />
      ) : (
        <span className="ek-hello-av" aria-hidden="true">{inicialDe(persona)}</span>
      )}
      <div className="ek-hello-t">
        <span className="ek-kicker ek-hello-kicker">{etiquetaRol(rol)} · {fechaLarga(ahora)}</span>
        <h2 className="ek-hello-h">{saludo(nombre, ahora)}</h2>
        <p className="ek-hello-p">{resumen}</p>
        {children && <div className="ek-hello-extra">{children}</div>}
      </div>
    </header>
  );
}
