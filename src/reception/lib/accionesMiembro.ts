import { backendPost } from '@shared/lib/backend';

/**
 * Acciones de front-desk sobre la cuenta de un miembro (Recepción Plus).
 * Todas pasan por Netlify functions con service_role que validan rol
 * recepcionista/admin + tenant y registran el cambio en audit_log (Bloque A).
 */

export interface MiembroPatch {
  nombre?: string;
  telefono?: string;
  email?: string;
  status?: string;
  membresia_tier?: string | null;
  unblock?: boolean;
  avatar?: { base64: string; contentType: string };
  /** Obligatorio (lo valida el backend) cuando cambia status/tier/unblock. */
  motivo?: string;
}

export interface UpdateResult {
  success: boolean;
  cambios?: string[];
  avatar_url?: string | null;
  sin_cambios?: boolean;
}

export function actualizarMiembro(usuario_id: string, patch: MiembroPatch): Promise<UpdateResult> {
  return backendPost<UpdateResult>('reception-update-member', { usuario_id, ...patch });
}

export interface ResetResult {
  success: boolean;
  email: string;
  password: string;
}

export function resetearPasswordMiembro(usuario_id: string): Promise<ResetResult> {
  return backendPost<ResetResult>('reception-reset-password', { usuario_id });
}

/**
 * Reduce una imagen a JPEG (lado máx `maxSide`px) y la devuelve como base64
 * sin el prefijo data-uri, listo para enviar a reception-update-member.
 * Sirve tanto para una foto de cámara como para un archivo subido.
 */
export async function imagenABase64Jpeg(
  source: Blob | HTMLVideoElement,
  maxSide = 640,
  quality = 0.82
): Promise<{ base64: string; contentType: string }> {
  const bitmap =
    source instanceof Blob ? await createImageBitmap(source) : null;
  const sw = bitmap ? bitmap.width : (source as HTMLVideoElement).videoWidth;
  const sh = bitmap ? bitmap.height : (source as HTMLVideoElement).videoHeight;
  const escala = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * escala);
  const h = Math.round(sh * escala);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo procesar la imagen');
  if (bitmap) ctx.drawImage(bitmap, 0, 0, w, h);
  else ctx.drawImage(source as HTMLVideoElement, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1] ?? '';
  return { base64, contentType: 'image/jpeg' };
}
