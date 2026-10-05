import { supabase } from './supabase';

/**
 * Material de las sesiones (solicitud del cliente, punto 5). Acceso a datos del
 * staff (subir / enlazar / retirar / avisar) y del miembro (listar / descargar).
 * Las escrituras van SIEMPRE por las RPC `staff_*_material`; ver la migración
 * 20260920220000 para las reglas de seguridad.
 */

export const BUCKET_MATERIAL = 'material';

/**
 * Tope de la subida DIRECTA, en MB. La subida estándar de Supabase manda el
 * archivo en una sola petición: por encima de unos cientos de MB se corta en
 * conexiones normales, y el plan del proyecto tiene su propio límite por archivo.
 * Para video pesado el camino es "Pegar enlace" (Drive, Dropbox, Frame.io…).
 */
export const MAX_MB_SUBIDA_DIRECTA = 500;

export interface Material {
  id: string;
  reserva_id: string;
  tipo: 'archivo' | 'enlace';
  titulo: string;
  storage_path: string | null;
  url_externa: string | null;
  nombre_archivo: string | null;
  tamano_bytes: number | null;
  mime: string | null;
  disponible_hasta: string | null;
  created_at: string;
}

export interface MaterialConSesion extends Material {
  reserva: { slot_inicio: string; folio: string | null; recurso: { nombre: string | null } | null } | null;
}

const COLUMNAS =
  'id, reserva_id, tipo, titulo, storage_path, url_externa, nombre_archivo, tamano_bytes, mime, disponible_hasta, created_at';

/** Quita el prefijo EKKO_CODIGO: de los errores de las RPC. */
export function mensajeHumano(mensaje: string): string {
  return mensaje.includes(': ') ? mensaje.split(': ').slice(1).join(': ') : mensaje;
}

// Cast: tabla y RPC nuevas, aún no están en los tipos generados de Supabase.
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc as unknown as Rpc;
const tabla = () => (supabase.from as any)('material_sesion');

/** "1.4 GB", "320 MB", "12 KB". */
export function formatTamano(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Nombre de objeto seguro: sin rutas, espacios ni caracteres raros; conserva la extensión. */
export function nombreSeguro(nombre: string): string {
  const limpio = nombre
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return (limpio || 'archivo').slice(-120);
}

/** <tenant>/<usuario>/<reserva>/<uuid>-<nombre> — la RPC exige este prefijo. */
export function rutaDeArchivo(p: { tenantId: string; usuarioId: string; reservaId: string; nombre: string; uuid?: string }): string {
  const id = p.uuid ?? crypto.randomUUID();
  return `${p.tenantId}/${p.usuarioId}/${p.reservaId}/${id}-${nombreSeguro(p.nombre)}`;
}

/** Días que le quedan (redondeo hacia arriba); null = no vence; ≤ 0 = vencido. */
export function diasRestantes(disponibleHasta: string | null, ahora: Date = new Date()): number | null {
  if (!disponibleHasta) return null;
  return Math.ceil((new Date(disponibleHasta).getTime() - ahora.getTime()) / 86_400_000);
}

// ── Staff ───────────────────────────────────────────────────────────────────

export async function listarMaterialDeReserva(reservaId: string): Promise<Material[]> {
  const { data, error } = await tabla()
    .select(COLUMNAS)
    .eq('reserva_id', reservaId)
    .is('eliminado_at', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error('No se pudo cargar el material de esta sesión.');
  return (data ?? []) as Material[];
}

export async function subirArchivo(p: {
  tenantId: string;
  usuarioId: string;
  reservaId: string;
  archivo: File;
  titulo: string;
  diasDisponible: number | null;
}): Promise<void> {
  if (p.archivo.size > MAX_MB_SUBIDA_DIRECTA * 1024 * 1024) {
    throw new Error(
      `El archivo pesa ${formatTamano(p.archivo.size)}. La subida directa admite hasta ${MAX_MB_SUBIDA_DIRECTA} MB: súbelo a Drive o Dropbox y usa "Pegar enlace".`
    );
  }
  const ruta = rutaDeArchivo({ tenantId: p.tenantId, usuarioId: p.usuarioId, reservaId: p.reservaId, nombre: p.archivo.name });
  const { error: upErr } = await supabase.storage
    .from(BUCKET_MATERIAL)
    .upload(ruta, p.archivo, { contentType: p.archivo.type || 'application/octet-stream', upsert: false });
  if (upErr) throw new Error(`No se pudo subir el archivo: ${upErr.message}`);

  try {
    const { error } = await rpc('staff_registrar_material', {
      p_reserva_id: p.reservaId,
      p_tipo: 'archivo',
      p_titulo: p.titulo,
      p_storage_path: ruta,
      p_nombre_archivo: p.archivo.name,
      p_tamano_bytes: p.archivo.size,
      p_mime: p.archivo.type || null,
      p_dias_disponible: p.diasDisponible
    });
    if (error) throw new Error(mensajeHumano(error.message));
  } catch (e) {
    // La fila no quedó (por un error de la RPC o por una falla de red/conexión
    // a medio camino): no dejar el objeto huérfano ocupando espacio. Con
    // .catch() porque si esta limpieza también falla, no debe tapar el error
    // original que sí le vamos a mostrar al staff.
    await supabase.storage.from(BUCKET_MATERIAL).remove([ruta]).catch(() => {});
    throw e instanceof Error ? e : new Error('No se pudo registrar el archivo.');
  }
}

export async function registrarEnlace(p: { reservaId: string; titulo: string; url: string; diasDisponible: number | null }): Promise<void> {
  const { error } = await rpc('staff_registrar_material', {
    p_reserva_id: p.reservaId,
    p_tipo: 'enlace',
    p_titulo: p.titulo,
    p_url_externa: p.url.trim(),
    p_dias_disponible: p.diasDisponible
  });
  if (error) throw new Error(mensajeHumano(error.message));
}

export async function eliminarMaterial(materialId: string): Promise<void> {
  const { data, error } = await rpc('staff_eliminar_material', { p_material_id: materialId });
  if (error) throw new Error(mensajeHumano(error.message));
  const ruta = (data as { storage_path?: string | null } | null)?.storage_path;
  // Best-effort: si falla, el cron de limpieza no lo verá (ya está retirado), pero
  // el miembro tampoco puede descargarlo: la policy exige una fila vigente.
  if (ruta) await supabase.storage.from(BUCKET_MATERIAL).remove([ruta]);
}

export async function avisarMaterial(reservaId: string): Promise<{ yaAvisado: boolean }> {
  const { data, error } = await rpc('staff_avisar_material', { p_reserva_id: reservaId });
  if (error) throw new Error(mensajeHumano(error.message));
  return { yaAvisado: Boolean((data as { ya_avisado?: boolean } | null)?.ya_avisado) };
}

// ── Miembro ─────────────────────────────────────────────────────────────────

/** Todo el material vigente del miembro (RLS lo acota a lo suyo y a lo no vencido). */
export async function listarMiMaterial(): Promise<MaterialConSesion[]> {
  const { data, error } = await tabla()
    .select(`${COLUMNAS}, reserva:reservas(slot_inicio, folio, recurso:recursos(nombre))`)
    .order('created_at', { ascending: false });
  if (error) throw new Error('No se pudo cargar tu material.');
  return (data ?? []) as MaterialConSesion[];
}

/** URL firmada (1 h) que fuerza la descarga con el nombre original. */
export async function urlDeDescarga(m: Pick<Material, 'tipo' | 'storage_path' | 'url_externa' | 'nombre_archivo'>): Promise<string> {
  if (m.tipo === 'enlace' && m.url_externa) return m.url_externa;
  if (!m.storage_path) throw new Error('Este material ya no está disponible.');
  const { data, error } = await supabase.storage
    .from(BUCKET_MATERIAL)
    .createSignedUrl(m.storage_path, 3600, { download: m.nombre_archivo ?? true });
  if (error || !data?.signedUrl) throw new Error('No se pudo preparar la descarga. Puede que el material haya vencido.');
  return data.signedUrl;
}

/** Agrupa por sesión (reserva), de la más reciente a la más antigua. */
export function agruparPorSesion(items: MaterialConSesion[]): Array<{ reservaId: string; sesion: MaterialConSesion['reserva']; archivos: MaterialConSesion[] }> {
  const porReserva = new Map<string, { reservaId: string; sesion: MaterialConSesion['reserva']; archivos: MaterialConSesion[] }>();
  for (const m of items) {
    const g = porReserva.get(m.reserva_id) ?? { reservaId: m.reserva_id, sesion: m.reserva, archivos: [] };
    g.archivos.push(m);
    porReserva.set(m.reserva_id, g);
  }
  return [...porReserva.values()].sort(
    (a, b) => new Date(b.sesion?.slot_inicio ?? 0).getTime() - new Date(a.sesion?.slot_inicio ?? 0).getTime()
  );
}
