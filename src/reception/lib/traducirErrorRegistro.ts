/**
 * Traduce los errores de `reception-create-member` (RP-1) a mensajes
 * claros para recepción (Sprint RP-4).
 *
 * La función ya devuelve mensajes amigables en español para los casos de
 * validación (`badRequest`), pero `serverError` puede arrastrar el mensaje
 * crudo de Supabase. El default genérico garantiza que ningún error
 * técnico llegue al mostrador.
 */
export function traducirErrorRegistro(message: string): string {
  const m = message.toLowerCase();

  if (
    m.includes('ya existe') ||
    m.includes('already') ||
    m.includes('exists') ||
    m.includes('registered')
  ) {
    return 'Ya existe una cuenta con ese email.';
  }
  if (m.includes('contraseña') && m.includes('8')) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  if (m.includes('email inválido') || m.includes('email invalido')) {
    return 'El email no es válido.';
  }
  if (m.includes('nombre requerido')) {
    return 'El nombre es obligatorio.';
  }
  if (
    m.includes('permiso') ||
    m.includes('forbidden') ||
    m.includes('recepción o admin') ||
    m.includes('recepcion o admin')
  ) {
    return 'No tenés permiso para registrar miembros.';
  }
  if (
    m.includes('sesión') ||
    m.includes('sesion') ||
    m.includes('token') ||
    m.includes('unauthorized') ||
    m.includes('bearer')
  ) {
    return 'Tu sesión expiró. Iniciá sesión de nuevo.';
  }

  // Fallback: nunca exponer el mensaje crudo del servidor.
  return 'No se pudo registrar al miembro. Intentá de nuevo.';
}
