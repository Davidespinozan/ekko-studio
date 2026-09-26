import { describe, it, expect } from 'vitest';
import { formatTamano, nombreSeguro, rutaDeArchivo, diasRestantes, agruparPorSesion, mensajeHumano, type MaterialConSesion } from '../material';

describe('material — utilidades', () => {
  it('formatTamano', () => {
    expect(formatTamano(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatTamano(320 * 1024 ** 2)).toBe('320 MB');
    expect(formatTamano(12_000)).toBe('12 KB');
    expect(formatTamano(null)).toBe('');
  });

  it('nombreSeguro: sin acentos, espacios ni rutas; conserva la extensión', () => {
    expect(nombreSeguro('Episodio 12 — versión FINAL (ñ).mp4')).toBe('Episodio-12-version-FINAL-n-.mp4');
    expect(nombreSeguro('../../etc/passwd')).toBe('etc-passwd');
    expect(nombreSeguro('   ')).toBe('archivo');
  });

  it('rutaDeArchivo: <tenant>/<usuario>/<reserva>/<uuid>-<nombre> (el prefijo que exige la RPC)', () => {
    expect(rutaDeArchivo({ tenantId: 't1', usuarioId: 'u1', reservaId: 'r1', nombre: 'mi video.mp4', uuid: 'abc' }))
      .toBe('t1/u1/r1/abc-mi-video.mp4');
  });

  it('diasRestantes: redondea hacia arriba; null = no vence; ≤ 0 = vencido', () => {
    const ahora = new Date('2026-09-20T12:00:00Z');
    expect(diasRestantes(null, ahora)).toBeNull();
    expect(diasRestantes('2026-09-23T12:00:00Z', ahora)).toBe(3);
    expect(diasRestantes('2026-09-20T18:00:00Z', ahora)).toBe(1);
    expect(diasRestantes('2026-09-19T12:00:00Z', ahora)).toBe(-1);
  });

  it('mensajeHumano quita el código EKKO_', () => {
    expect(mensajeHumano('EKKO_ENLACE_INVALIDO: El enlace debe empezar con https://')).toBe('El enlace debe empezar con https://');
    expect(mensajeHumano('sin código')).toBe('sin código');
  });

  it('agruparPorSesion: por reserva, de la sesión más reciente a la más antigua', () => {
    const m = (id: string, reserva: string, inicio: string): MaterialConSesion => ({
      id, reserva_id: reserva, tipo: 'enlace', titulo: id, storage_path: null, url_externa: 'https://x', nombre_archivo: null,
      tamano_bytes: null, mime: null, disponible_hasta: null, created_at: inicio,
      reserva: { slot_inicio: inicio, folio: null, recurso: { nombre: 'Set' } }
    });
    const g = agruparPorSesion([m('a', 'r-vieja', '2026-08-01T00:00:00Z'), m('b', 'r-nueva', '2026-09-01T00:00:00Z'), m('c', 'r-vieja', '2026-08-01T00:00:00Z')]);
    expect(g.map((x) => x.reservaId)).toEqual(['r-nueva', 'r-vieja']);
    expect(g[1].archivos.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
