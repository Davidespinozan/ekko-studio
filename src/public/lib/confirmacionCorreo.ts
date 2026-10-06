/**
 * PKG-06C (FR-24) · Enlace de confirmación del alta pública.
 *
 * El correo trae `/confirmar-correo?token_hash=…&type=…`. El token lo genera y lo
 * verifica el proveedor de Auth (`verifyOtp`); EKKO no lo guarda. Aquí solo se
 * valida su forma y se acepta una lista cerrada de tipos: un enlace de
 * recuperación o de cambio de correo no entra por esta puerta.
 */
export type TipoEnlaceConfirmacion = 'magiclink' | 'signup' | 'invite' | 'email';

const TIPOS: ReadonlySet<string> = new Set<TipoEnlaceConfirmacion>(['magiclink', 'signup', 'invite', 'email']);

export interface EnlaceConfirmacion {
  tokenHash: string;
  tipo: TipoEnlaceConfirmacion;
}

export function leerEnlaceConfirmacion(search: string): EnlaceConfirmacion | null {
  const p = new URLSearchParams(search);
  const tokenHash = p.get('token_hash') ?? '';
  const tipo = p.get('type') ?? '';
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash) || !TIPOS.has(tipo)) return null;
  return { tokenHash, tipo: tipo as TipoEnlaceConfirmacion };
}
