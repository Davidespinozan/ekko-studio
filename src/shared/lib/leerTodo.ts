/**
 * PKG-06F (FR-62) · Leer una lista COMPLETA a pesar del tope de 1000 filas de
 * PostgREST (`max_rows`). Se pide la primera página con `count: 'exact'` y se
 * sigue por `.range()` hasta tener exactamente ese total. Si el servidor corta
 * antes (tope distinto, filas que cambian entre páginas) o se pasa del máximo
 * de seguridad, se FALLA: nunca se devuelve una lista truncada como si fuera
 * completa.
 *
 * Es para LISTAS acotadas (una ventana de fechas, un padrón). Un total o un
 * conteo que crece con el tiempo NO se calcula leyendo filas: va a una RPC que
 * agrega en la base.
 *
 * La consulta debe tener orden estable (incluir una columna única, p. ej. `id`).
 */

export const TAM_PAGINA = 1000;
export const MAX_FILAS = 50_000;

export type Pagina<T> = (desde: number, hasta: number) => PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
}>;

export class LecturaIncompletaError extends Error {
  constructor(motivo: string) {
    super(`lectura_incompleta: ${motivo}`);
    this.name = 'LecturaIncompletaError';
  }
}

export async function leerTodo<T>(pagina: Pagina<T>, opts: { tamano?: number; maxFilas?: number } = {}): Promise<T[]> {
  const tamano = opts.tamano ?? TAM_PAGINA;
  const maxFilas = opts.maxFilas ?? MAX_FILAS;
  const primera = await pagina(0, tamano - 1);
  if (primera.error) throw primera.error;
  const total = primera.count;
  if (total == null) throw new LecturaIncompletaError('la consulta no trajo el conteo exacto');
  if (total > maxFilas) throw new LecturaIncompletaError(`${total} filas superan el máximo de ${maxFilas}`);
  const filas: T[] = [...(primera.data ?? [])];
  while (filas.length < total) {
    const r = await pagina(filas.length, filas.length + tamano - 1);
    if (r.error) throw r.error;
    const lote = r.data ?? [];
    if (lote.length === 0) break;
    filas.push(...lote);
  }
  if (filas.length !== total) throw new LecturaIncompletaError(`se leyeron ${filas.length} de ${total}`);
  return filas;
}
