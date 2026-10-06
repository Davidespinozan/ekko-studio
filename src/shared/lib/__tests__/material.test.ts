import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatTamano,
  nombreSeguro,
  rutaDeArchivo,
  diasRestantes,
  agruparPorSesion,
  mensajeHumano,
  subirArchivo,
  marcarMaterialRequerido,
  listarMaterialPendiente,
  eliminarMaterial,
  mensajeSubidaFallida,
  type MaterialConSesion
} from '../material';

/**
 * Caso real de producción (2026-10-04): 2 archivos quedaron huérfanos en Storage
 * porque el registro en la base falló a medio camino y nadie los limpió — el
 * staff vio el archivo "subido" pero el botón de avisar nunca se activó (no hay
 * fila en material_sesion). subirArchivo debe limpiar el objeto de Storage sea
 * cual sea la forma en que falle el registro: un {error} de la RPC o una
 * excepción (p. ej. conexión cortada a medio camino).
 *
 * Causa raíz real (encontrada 2026-10-05, con el usuario reproduciéndola en
 * vivo): `rpc()` en supabase-js es un método que depende de `this.rest`.
 * `supabase.rpc` nunca se guarda en una variable suelta: el mock de abajo
 * imita esa dependencia (igual que la clase real) para que extraer la
 * referencia truene con el mismo TypeError que en producción.
 */
const h = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn()
}));
vi.mock('../supabase', () => ({
  supabase: {
    rest: {},
    storage: { from: () => ({ upload: h.upload, remove: h.remove }) },
    // Método real de supabase-js (no una arrow function ligada): depende de
    // `this.rest`, así que una llamada sin receptor (`const rpc = supabase.rpc;
    // rpc(...)`) truena igual que en producción.
    rpc(fn: string, args: Record<string, unknown>) {
      void this.rest;
      return h.rpc(fn, args);
    }
  }
}));

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

describe('subirArchivo — limpieza del objeto huérfano si el registro no queda', () => {
  const archivo = new File(['contenido'], 'video.mp4', { type: 'video/mp4' });
  const p = { tenantId: 't1', usuarioId: 'u1', reservaId: 'r1', archivo, titulo: 'Título', diasDisponible: 30 };

  beforeEach(() => {
    h.upload.mockReset().mockResolvedValue({ error: null });
    h.remove.mockReset().mockResolvedValue({ error: null });
    h.rpc.mockReset();
  });

  it('feliz: sube y registra sin tocar remove()', async () => {
    h.rpc.mockResolvedValue({ data: { success: true }, error: null });
    await subirArchivo(p);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('la RPC responde {error}: limpia el objeto y lanza el mensaje humano', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_RUTA_INVALIDA: El archivo no está en la carpeta de esta reserva' } });
    await expect(subirArchivo(p)).rejects.toThrow('El archivo no está en la carpeta de esta reserva');
    expect(h.remove).toHaveBeenCalledWith([expect.stringContaining('t1/u1/r1/')]);
  });

  it('la RPC se cae a medio camino (lanza en vez de devolver {error}): también limpia el objeto', async () => {
    h.rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(subirArchivo(p)).rejects.toThrow('Failed to fetch');
    expect(h.remove).toHaveBeenCalledWith([expect.stringContaining('t1/u1/r1/')]);
  });

  it('si la limpieza también falla, no tapa el error original', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_SIN_MATERIAL: algo' } });
    h.remove.mockRejectedValue(new Error('storage caído'));
    await expect(subirArchivo(p)).rejects.toThrow('algo');
  });
});

describe('marcarMaterialRequerido', () => {
  beforeEach(() => h.rpc.mockReset());

  it('llama a la RPC con el valor pedido', async () => {
    h.rpc.mockResolvedValue({ data: { success: true }, error: null });
    await marcarMaterialRequerido('r1', false);
    expect(h.rpc).toHaveBeenCalledWith('staff_marcar_material_requerido', { p_reserva_id: 'r1', p_requerido: false });
  });

  it('error de la RPC → mensaje humano', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede marcar esto' } });
    await expect(marcarMaterialRequerido('r1', true)).rejects.toThrow('Solo el equipo del estudio puede marcar esto');
  });
});

describe('listarMaterialPendiente', () => {
  beforeEach(() => h.rpc.mockReset());

  it('devuelve las filas de la RPC', async () => {
    const filas = [{ reserva_id: 'r1', usuario_id: 'u1', folio: 'F-1', slot_inicio: 'x', slot_fin: 'y', recurso_nombre: 'Estudio 1' }];
    h.rpc.mockResolvedValue({ data: filas, error: null });
    expect(await listarMaterialPendiente()).toEqual(filas);
  });

  it('sin datos → []', async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await listarMaterialPendiente()).toEqual([]);
  });

  it('error → mensaje humano', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_NO_AUTH: Usuario no autenticado' } });
    await expect(listarMaterialPendiente()).rejects.toThrow('Usuario no autenticado');
  });
});

describe('PKG-06E · subida: el error del proveedor no llega a la pantalla (FR-42)', () => {
  const archivo = new File(['contenido'], 'video.mp4', { type: 'video/mp4' });
  const p = { tenantId: 't1', usuarioId: 'u1', reservaId: 'r1', archivo, titulo: 'Título', diasDisponible: 30 };
  beforeEach(() => {
    h.upload.mockReset();
    h.remove.mockReset().mockResolvedValue({ error: null });
    h.rpc.mockReset();
  });

  it('5 · fallo de Storage al subir → texto fijo, sin el mensaje crudo; no se registra nada', async () => {
    h.upload.mockResolvedValue({ error: { message: 'new row violates row-level security policy for table "objects"', statusCode: '403' } });
    await expect(subirArchivo(p)).rejects.toThrow('No se pudo subir el archivo. Revisa tu conexión e intenta de nuevo.');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('demasiado grande (413 / "exceeded") → manda a "Pegar enlace"', () => {
    expect(mensajeSubidaFallida({ message: 'The object exceeded the maximum allowed size', statusCode: '413' })).toMatch(/Pegar enlace/);
    expect(mensajeSubidaFallida({ message: 'Payload too large' })).toMatch(/Pegar enlace/);
    expect(mensajeSubidaFallida(null)).toBe('No se pudo subir el archivo. Revisa tu conexión e intenta de nuevo.');
  });

  it('3/4 · el registro falla Y la limpieza devuelve {error}: la subida NO se da por buena (error original)', async () => {
    h.upload.mockResolvedValue({ error: null });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_RESERVA_NO_VALIDA: No se entrega material de una sesión cancelada' } });
    h.remove.mockResolvedValue({ data: null, error: { message: 'storage caído' } });
    await expect(subirArchivo(p)).rejects.toThrow('No se entrega material de una sesión cancelada');
    expect(h.remove).toHaveBeenCalledTimes(1);
  });

  it('2 · el registro falla y la limpieza sí borra: mismo error original', async () => {
    h.upload.mockResolvedValue({ error: null });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_RUTA_INVALIDA: El archivo no está en la carpeta de esta reserva' } });
    await expect(subirArchivo(p)).rejects.toThrow('El archivo no está en la carpeta de esta reserva');
  });
});

describe('PKG-06E · retirar material (FR-43)', () => {
  beforeEach(() => {
    h.remove.mockReset();
    h.rpc.mockReset();
  });

  it('6/8 · retira (la base primero) y borra el objeto con la ruta que devolvió la base → sin limpieza pendiente', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, ya_retirado: false, storage_path: 't1/u1/r1/a-video.mp4' }, error: null });
    h.remove.mockResolvedValue({ data: [{ name: 't1/u1/r1/a-video.mp4' }], error: null });
    expect(await eliminarMaterial('m1')).toEqual({ limpiezaPendiente: false });
    expect(h.rpc).toHaveBeenCalledWith('staff_eliminar_material', { p_material_id: 'm1' });
    expect(h.remove).toHaveBeenCalledWith(['t1/u1/r1/a-video.mp4']);
  });

  it('9 · Storage devuelve {error} → retirado igual, pero se dice que la limpieza queda pendiente', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, storage_path: 't1/u1/r1/a.mp4' }, error: null });
    h.remove.mockResolvedValue({ data: null, error: { message: 'gateway timeout' } });
    expect(await eliminarMaterial('m1')).toEqual({ limpiezaPendiente: true });
  });

  it('resultado desconocido (lanza) → limpieza pendiente, sin propagar el error crudo', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, storage_path: 't1/u1/r1/a.mp4' }, error: null });
    h.remove.mockRejectedValue(new Error('NetworkError'));
    expect(await eliminarMaterial('m1')).toEqual({ limpiezaPendiente: true });
  });

  it('10/11 · retirar dos veces converge (ya_retirado) y "ya no estaba" (data vacía, sin error) es éxito', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, ya_retirado: true, storage_path: 't1/u1/r1/a.mp4' }, error: null });
    h.remove.mockResolvedValue({ data: [], error: null });
    expect(await eliminarMaterial('m1')).toEqual({ limpiezaPendiente: false });
  });

  it('enlace (sin ruta) → no toca Storage', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, storage_path: null }, error: null });
    expect(await eliminarMaterial('m1')).toEqual({ limpiezaPendiente: false });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('12 · la ruta borrada es SOLO la de la base: la función no acepta una ruta del llamador', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, storage_path: 't1/u1/r1/b.mp4' }, error: null });
    h.remove.mockResolvedValue({ data: [], error: null });
    await (eliminarMaterial as unknown as (id: string, ruta: string) => Promise<unknown>)('m1', 'otro-tenant/x/y/z.mp4');
    expect(h.remove).toHaveBeenCalledWith(['t1/u1/r1/b.mp4']);
  });

  it('error de la RPC (p. ej. otro estudio) → mensaje humano y Storage intacto', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_MATERIAL_NO_EXISTE: Material no encontrado' } });
    await expect(eliminarMaterial('m1')).rejects.toThrow('Material no encontrado');
    expect(h.remove).not.toHaveBeenCalled();
  });
});
