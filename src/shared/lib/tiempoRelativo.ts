// ============================================================================
// tiempoRelativo — "hace 5 min", "hace 2 h", "ayer"… para timestamps recientes.
// Pura y con `ahora` inyectable para tests. Español, sin dependencias.
// ============================================================================

export function tiempoRelativo(iso: string, ahora: Date = new Date()): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';

  const segundos = Math.round((ahora.getTime() - fecha.getTime()) / 1000);

  // Futuro o casi-ahora → "ahora".
  if (segundos < 45) return 'ahora';

  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;

  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;

  const dias = Math.round(horas / 24);
  if (dias === 1) return 'ayer';
  if (dias < 7) return `hace ${dias} días`;

  const semanas = Math.round(dias / 7);
  if (semanas < 5) return semanas === 1 ? 'hace 1 semana' : `hace ${semanas} semanas`;

  // Más de un mes → fecha corta.
  return fecha.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
