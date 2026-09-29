/**
 * PKG-02B (C04) · Observar (solo LEER) hasta que aparezca la evidencia esperada.
 *
 * Genérico y sin negocio: el llamador decide qué leer y cuándo la lectura prueba
 * el derecho (`listo`). Nunca escribe, nunca reintenta pagos.
 *
 *  - observada:    `listo(dato)` fue true en alguna lectura.
 *  - no_observada: se agotaron los intentos con lecturas correctas → NO es fallo
 *                  del pago; es "todavía no se refleja".
 *  - error:        la última lectura falló → no se puede afirmar ni ausencia ni
 *                  presencia del derecho (jamás "no tienes plan").
 */
export type ObservacionActivacion<T> =
  | { resultado: 'observada'; dato: T }
  | { resultado: 'no_observada'; ultimo: T | null }
  | { resultado: 'error' };

export interface OpcionesObservar<T> {
  leer: () => Promise<{ data: T | null; error: unknown }>;
  listo: (dato: T) => boolean;
  /** Lecturas máximas (default 12). */
  intentos?: number;
  /** Milisegundos entre lecturas (default 2500). La primera lectura también espera. */
  cada?: number;
  /** Inyectable en tests. */
  esperar?: (ms: number) => Promise<void>;
  /** Permite cancelar (p. ej. el componente se desmontó). */
  cancelado?: () => boolean;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function observarActivacion<T>(o: OpcionesObservar<T>): Promise<ObservacionActivacion<T>> {
  const intentos = Math.max(1, o.intentos ?? 12);
  const cada = o.cada ?? 2500;
  const esperar = o.esperar ?? dormir;
  let ultimo: T | null = null;
  let ultimaFallo = false;
  for (let i = 0; i < intentos; i++) {
    await esperar(cada);
    if (o.cancelado?.()) return ultimaFallo ? { resultado: 'error' } : { resultado: 'no_observada', ultimo };
    let lectura: { data: T | null; error: unknown };
    try {
      lectura = await o.leer();
    } catch (e) {
      lectura = { data: null, error: e };
    }
    if (lectura.error) {
      ultimaFallo = true;
      continue; // un fallo de red no es ausencia: seguir leyendo
    }
    ultimaFallo = false;
    ultimo = lectura.data;
    if (lectura.data !== null && lectura.data !== undefined && o.listo(lectura.data)) {
      return { resultado: 'observada', dato: lectura.data };
    }
  }
  return ultimaFallo ? { resultado: 'error' } : { resultado: 'no_observada', ultimo };
}
