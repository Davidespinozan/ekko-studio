/**
 * PKG-02A (C02) · EMPTY ≠ ERROR ≠ LOADING ≠ STALE.
 *
 * Qué debe pintar una pantalla con lo que devuelve un hook de lectura:
 *  - cargando: primer fetch en curso, sin dato;
 *  - error:    nunca hubo dato válido y la lectura falló → estado de error
 *              (jamás el vacío legítimo);
 *  - stale:    hubo dato válido y la última actualización falló → dato
 *              conservado + aviso "no pudimos actualizar";
 *  - ok:       dato válido (el vacío legítimo se decide con la colección).
 *
 * `stale` solo existe si el hook expone `cargado` (hubo éxito antes); nunca se
 * fabrica a partir del valor inicial.
 */
export type EstadoCarga = 'cargando' | 'error' | 'stale' | 'ok';

export function estadoDeCarga(h: { isLoading: boolean; error: boolean; cargado?: boolean }): EstadoCarga {
  const cargado = h.cargado === true;
  if (h.error) return cargado ? 'stale' : 'error';
  if (h.isLoading && !cargado) return 'cargando';
  return 'ok';
}
