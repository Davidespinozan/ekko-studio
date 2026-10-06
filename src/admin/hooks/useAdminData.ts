import { useCallback, useEffect, useState } from 'react';
import { traducirErrorTier } from '../lib/traducirErrorTier';
import { supabase } from '@shared/lib/supabase';
import { COLUMNAS_RESERVA_CLIENTE, COLUMNAS_USUARIO_CLIENTE, type UsuarioCliente } from '@shared/lib/columnas';
import { useTenant } from '@shared/hooks/useTenant';
import { leerTodo } from '@shared/lib/leerTodo';
import { backendPost } from '@shared/lib/backend';
import { inicioDeHoyEnZona, inicioDeMesEnZona, fechaISOEnZona } from '@shared/lib/timezone';
import type { Database } from '@shared/types/database';

// PKG-06D: el cliente solo lee las columnas permitidas de `usuarios`.
type Usuario = UsuarioCliente;
type Recurso = Database['public']['Tables']['recursos']['Row'];
type Tier = Database['public']['Tables']['tiers']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

export interface MiembroRow extends Usuario {
  reservas_count?: number;
}

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
  // Aún no está en los tipos generados de Supabase (columna nueva).
  material_requerido: boolean;
}

/**
 * Lista de miembros del tenant (sin paginación por simplicidad inicial).
 */
export function useMiembros(filtros?: { search?: string; status?: string; rol?: string | 'staff' }) {
  const [miembros, setMiembros] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): un fallo de la consulta no es "todavía no hay miembros".
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    // PKG-06D (FR-27): el texto de búsqueda viaja como PARÁMETRO de la RPC
    // `buscar_cuentas_staff` (ILIKE con escape en el servidor), nunca interpolado
    // en la gramática `.or()` de PostgREST. La RPC filtra por el tenant del
    // caller y devuelve solo columnas permitidas; "staff" agrupa recepción/admin.
    // PKG-06F (FR-62): la lista se trae COMPLETA (páginas del mismo orden que la RPC,
    // `created_at` desc + `id`, con conteo exacto); antes se cortaba en 1000 sin aviso.
    let data: Usuario[];
    try {
      data = await leerTodo<Usuario>((desde, hasta) =>
        supabase
          .rpc('buscar_cuentas_staff', {
            p_texto: filtros?.search?.trim() || null,
            p_rol: filtros?.rol || null,
            p_status: filtros?.status || null
          }, { count: 'exact' })
          .order('created_at', { ascending: false })
          .order('id')
          .range(desde, hasta) as unknown as PromiseLike<{ data: Usuario[] | null; error: { message: string } | null; count: number | null }>
      );
    } catch (qErr) {
      console.error('[useMiembros]', qErr);
      setError(true); // la lista anterior se conserva
      setIsLoading(false);
      return;
    }
    setMiembros(data);
    setIsLoading(false);
  }, [filtros?.search, filtros?.status, filtros?.rol]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembros, isLoading, error, refetch };
}

/**
 * Detalle de 1 miembro con sus reservas.
 */
export function useMiembroDetalle(miembroId: string | undefined) {
  const [miembro, setMiembro] = useState<Usuario | null>(null);
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  // PKG-06D: `notas_admin` ya no viaja por REST; se lee por la RPC de staff.
  const [notasAdmin, setNotasAdmin] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!miembroId) return;
    setIsLoading(true);

    const [m, r, n] = await Promise.all([
      supabase.from('usuarios').select(COLUMNAS_USUARIO_CLIENTE).eq('id', miembroId).maybeSingle(),
      supabase
        .from('reservas')
        .select(`${COLUMNAS_RESERVA_CLIENTE}, recurso:recursos(id, slug, nombre)`)
        .eq('usuario_id', miembroId)
        .order('slot_inicio', { ascending: false })
        .limit(50),
      supabase.rpc('staff_datos_internos_cuenta', { p_usuario_id: miembroId }).then(({ data }) => (data as { notas_admin?: string | null } | null)?.notas_admin ?? null)
    ]);

    setMiembro((m.data ?? null) as unknown as Usuario | null);
    setReservas((r.data ?? []) as unknown as ReservaConJoin[]);
    setNotasAdmin(n);
    setIsLoading(false);
  }, [miembroId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembro, reservas, notasAdmin, isLoading, refetch };
}

export interface MembresiaResumen {
  usuario_id: string;
  status: string;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  tier: { slug: string; nombre: string; tipo: string | null } | null;
}

/**
 * Membresías VIVAS del tenant, indexadas por usuario (una por miembro). Para la
 * columna "Membresía" de la lista: vigente / por vencer / vencida por fecha /
 * sin membresía — en vez del `membresia_tier` crudo de `usuarios`.
 */
export function useMembresiasVigentesPorUsuario() {
  const tenant = useTenant();
  const [porUsuario, setPorUsuario] = useState<Map<string, MembresiaResumen>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): si la consulta falla, un mapa vacío etiquetaba a TODOS los
  // miembros como "SIN MEMBRESÍA". Con `error=true` la lista dice "no disponible".
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    try {
      // PKG-06F (FR-62): COMPLETA (por páginas con conteo exacto). Con más de 1000
      // membresías vivas, el resto de los miembros salía "SIN MEMBRESÍA" sin aviso.
      const data = await leerTodo<MembresiaResumen>((desde, hasta) =>
        supabase
          .from('membresias')
          .select('usuario_id, status, periodo_actual_fin, creditos_restantes, created_at, tier:tiers(slug, nombre, tipo)', { count: 'exact' })
          .eq('tenant_id', tenant.id)
          .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
          .order('created_at', { ascending: false })
          .order('id')
          .range(desde, hasta) as unknown as PromiseLike<{ data: MembresiaResumen[] | null; error: { message: string } | null; count: number | null }>
      );
      const map = new Map<string, MembresiaResumen>();
      for (const m of data) {
        if (!map.has(m.usuario_id)) map.set(m.usuario_id, m); // la más reciente gana
      }
      setPorUsuario(map);
    } catch (e) {
      console.error('[useMembresiasVigentesPorUsuario]', e instanceof Error ? e.message : e);
      setError(true);
    } finally {
      setIsLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => { refetch(); }, [refetch]);
  return { porUsuario, isLoading, error, refetch };
}

/** IDs de miembro con al menos una sesión pendiente de material (filtro `?filtro=material_pendiente` de Miembros). */
export function useMaterialPendientePorUsuario() {
  const [usuarioIds, setUsuarioIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const { data, error: qErr } = await (supabase.rpc as any)('staff_listar_material_pendiente');
    if (qErr) {
      console.error('[useMaterialPendientePorUsuario]', qErr);
      setError(true); // el conjunto anterior se conserva
      setIsLoading(false);
      return;
    }
    setUsuarioIds(new Set((data ?? []).map((r: { usuario_id: string }) => r.usuario_id)));
    setIsLoading(false);
  }, []);

  useEffect(() => { refetch(); }, [refetch]);
  return { usuarioIds, isLoading, error, refetch };
}

export interface MembresiaActualAdmin {
  id: string;
  status: string;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean | null;
  created_at: string;
  tier: { slug: string; nombre: string; tipo: string | null } | null;
}

/**
 * Membresía VIGENTE del miembro leída de `membresias` (la fuente de verdad que
 * usan recepción, reportes y el webhook), no de `usuarios.membresia_tier`.
 * Devuelve null si no tiene ninguna viva (trialing/activa/past_due).
 */
export function useMembresiaActualAdmin(usuarioId: string | undefined) {
  const [membresia, setMembresia] = useState<MembresiaActualAdmin | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): error ≠ "sin membresía". La ficha no ofrece asignar/vender
  // plan mientras `error=true`.
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    if (!usuarioId) return;
    setIsLoading(true);
    setError(false);
    const { data, error: qErr } = await supabase
      .from('membresias')
      .select('id, status, periodo_actual_fin, creditos_restantes, stripe_subscription_id, cancel_at_period_end, created_at, tier:tiers(slug, nombre, tipo)')
      .eq('usuario_id', usuarioId)
      .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (qErr) {
      console.error('[useMembresiaActualAdmin]', qErr);
      setError(true); // se conserva la membresía anterior (o null si nunca cargó)
      setIsLoading(false);
      return;
    }
    setMembresia((data as unknown as MembresiaActualAdmin | null) ?? null);
    setIsLoading(false);
  }, [usuarioId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { membresia, isLoading, error, refetch };
}

// R2-A (PKG-01L): se retiró `updateMiembro` (código muerto que escribía rol /
// membresia_tier por REST). El admin ya no muta esos campos directo: rol va por
// admin-update-role y el plan por las RPC de membresía.

/**
 * Recursos del tenant (admin ve todos, incluso inactivos).
 */
export function useRecursosAdmin() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): error ≠ "no hay estudios activos".
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const { data, error: qErr } = await supabase
      .from('recursos')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true });
    if (qErr) {
      console.error('[useRecursosAdmin]', qErr);
      setError(true); // la lista anterior se conserva
      setIsLoading(false);
      return;
    }
    setRecursos(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => { refetch(); }, [refetch]);
  return { recursos, isLoading, error, refetch };
}

export async function updateRecurso(
  recursoId: string,
  patch: Partial<Pick<Recurso,
    | 'nombre'
    | 'descripcion'
    | 'horarios'
    | 'tiers_permitidos'
    | 'activo'
    | 'orden'
    | 'cupos'
    | 'foto_url'
    | 'capacidad_personas'
    | 'costo_creditos'
    | 'max_invitados_extra'
    | 'tipo_contenido'
    | 'equipo_incluido'
    | 'estilo_visual'
  >>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('recursos').update(patch).eq('id', recursoId);
  return { error: error?.message ?? null };
}

export async function insertRecurso(
  payload: Database['public']['Tables']['recursos']['Insert']
): Promise<{ error: string | null; data: Recurso | null }> {
  const { data, error } = await supabase
    .from('recursos')
    .insert(payload)
    .select('*')
    .single();
  return { error: error?.message ?? null, data: (data as Recurso | null) ?? null };
}

/**
 * Tiers del tenant.
 */
export function useTiersAdmin() {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): error ≠ "no hay planes activos".
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const { data, error: qErr } = await supabase
      .from('tiers')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true });
    if (qErr) {
      console.error('[useTiersAdmin]', qErr);
      setError(true); // la lista anterior se conserva
      setIsLoading(false);
      return;
    }
    setTiers(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => { refetch(); }, [refetch]);
  return { tiers, isLoading, error, refetch };
}

export async function updateTier(
  tierId: string,
  patch: Partial<Pick<Tier, 'nombre' | 'descripcion' | 'precio_centavos' | 'beneficios' | 'reglas' | 'activo' | 'en_venta' | 'orden' | 'slug' | 'tipo' | 'clases_incluidas' | 'duracion_dias' | 'stripe_price_id'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('tiers').update(patch).eq('id', tierId);
  return { error: error ? traducirErrorTier(error.message) : null };
}

export async function insertTier(
  payload: Database['public']['Tables']['tiers']['Insert']
): Promise<{ error: string | null; data: Tier | null }> {
  const { data, error } = await supabase
    .from('tiers')
    .insert(payload)
    .select('*')
    .single();
  return { error: error ? traducirErrorTier(error.message) : null, data: (data as Tier | null) ?? null };
}

/**
 * Métricas del dashboard admin.
 */
export function useAdminMetrics() {
  const tenant = useTenant();
  const [metrics, setMetrics] = useState<{
    miembrosActivos: number;
    miembrosTotal: number;
    reservasHoy: number;
    reservasEsteMes: number;
    noShowsMes: number;
    ocupacion7d: number;
    proximasReservas: ReservaConJoin[];
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const now = new Date();
      const inicioHoy = inicioDeHoyEnZona(now);
      const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
      const inicioMes = inicioDeMesEnZona(0, now);
      const hace7d = new Date(inicioHoy.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [activos, total, hoy, mes, noShows, reservas7d, proximas] = await Promise.all([
        supabase
          .from('usuarios')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro')
          .eq('status', 'activo'),
        supabase
          .from('usuarios')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('rol', 'miembro'),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .in('status', ['confirmada', 'completada'])
          .gte('slot_inicio', inicioHoy.toISOString())
          .lt('slot_inicio', finHoy.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('slot_inicio', inicioMes.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .eq('status', 'no_show')
          .gte('slot_inicio', inicioMes.toISOString()),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id)
          .neq('status', 'cancelada')
          .gte('slot_inicio', hace7d.toISOString())
          .lt('slot_inicio', inicioHoy.toISOString()),
        supabase
          .from('reservas')
          .select(`${COLUMNAS_RESERVA_CLIENTE}, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)`)
          .eq('tenant_id', tenant.id)
          .eq('status', 'confirmada')
          .gte('slot_inicio', now.toISOString())
          .order('slot_inicio', { ascending: true })
          .limit(5)
      ]);

      if (!mounted) return;

      // 13 slots operativos × 3 estudios × 7 días = 273 slots disponibles/semana
      const SLOTS_DISPONIBLES_7D = 13 * 3 * 7;
      const ocupacion7d = Math.round(((reservas7d.count ?? 0) / SLOTS_DISPONIBLES_7D) * 100);

      setMetrics({
        miembrosActivos: activos.count ?? 0,
        miembrosTotal: total.count ?? 0,
        reservasHoy: hoy.count ?? 0,
        reservasEsteMes: mes.count ?? 0,
        noShowsMes: noShows.count ?? 0,
        ocupacion7d,
        proximasReservas: (proximas.data ?? []) as unknown as ReservaConJoin[]
      });
      setIsLoading(false);
    }

    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  return { metrics, isLoading };
}

/**
 * Datos para Dashboard (Sprint Final).
 *
 * Devuelve métricas relevantes para 3 secciones del dashboard:
 *   - HOY: reservas del día con join a recurso/usuario
 *   - TU MES: 3 contadores (reservas, miembros nuevos, no-shows) con
 *     valores del mes anterior para calcular tendencia
 *   - GRAFICA: reservas por día en los últimos 30 días
 *
 * NO incluye datos de dinero — esos quedan deshabilitados hasta Stripe.
 */
export interface DashboardData {
  reservasHoy: ReservaConJoin[];
  reservasMesActual: number;
  reservasMesAnterior: number;
  miembrosNuevosMesActual: number;
  miembrosNuevosMesAnterior: number;
  noShowsMesActual: number;
  noShowsMesAnterior: number;
  totalReservasMesAnteriorParaNoShows: number;
  reservasUltimos30Dias: Array<{ fecha: string; count: number }>;
}

export function useDashboardData() {
  const tenant = useTenant();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const now = new Date();
    const inicioHoy = inicioDeHoyEnZona(now);
    const finHoy = new Date(inicioHoy.getTime() + 24 * 60 * 60 * 1000);
    const inicioMes = inicioDeMesEnZona(0, now);
    const inicioMesAnterior = inicioDeMesEnZona(-1, now);
    const finMesAnterior = inicioMes;
    const hace30dias = new Date(inicioHoy.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      reservasHoy,
      reservasMesActual,
      reservasMesAnterior,
      miembrosMesActual,
      miembrosMesAnterior,
      noShowsActual,
      noShowsAnterior,
      reservasMesAnteriorTotales,
      reservas30d
    ] = await Promise.all([
      supabase
        .from('reservas')
        .select(
          `${COLUMNAS_RESERVA_CLIENTE}, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)`
        )
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioHoy.toISOString())
        .lt('slot_inicio', finHoy.toISOString())
        .order('slot_inicio', { ascending: true }),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMes.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .gte('created_at', inicioMes.toISOString()),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .gte('created_at', inicioMesAnterior.toISOString())
        .lt('created_at', finMesAnterior.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', inicioMes.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', inicioMesAnterior.toISOString())
        .lt('slot_inicio', finMesAnterior.toISOString()),
      // PKG-06F (FR-62/63): la serie de 30 días se CUENTA en la base, por día del
      // estudio (antes: una fila por reserva, recortada a 1000 por el servidor).
      (supabase.rpc as unknown as <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { message: string } | null }>)<{ dia: string; n: number }[]>('reservas_por_dia_estudio', {
        p_desde: hace30dias.toISOString(),
        p_hasta: finHoy.toISOString()
      })
    ]);

    // ERROR-UI-FIX E-03: si CUALQUIERA de las 9 queries falló, no pintar un
    // dashboard en cero como si fuera dato válido — exponer el error.
    const fallo = [
      reservasHoy, reservasMesActual, reservasMesAnterior,
      miembrosMesActual, miembrosMesAnterior, noShowsActual,
      noShowsAnterior, reservasMesAnteriorTotales, reservas30d
    ].find((r) => r.error);
    if (fallo) {
      console.error('[useDashboardData]', fallo.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    // Agrupar reservas por día (YYYY-MM-DD)
    // Claves = día DEL ESTUDIO (antes: día UTC → una sesión a las 20:00 en
    // Culiacán caía en el día siguiente de la gráfica).
    const conteoPorDia: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(hace30dias.getTime() + i * 24 * 60 * 60 * 1000);
      conteoPorDia[fechaISOEnZona(d)] = 0;
    }
    for (const r of reservas30d.data ?? []) {
      const k = String(r.dia).slice(0, 10);
      if (k in conteoPorDia) conteoPorDia[k] += Number(r.n);
    }
    const reservasUltimos30Dias = Object.entries(conteoPorDia).map(([fecha, count]) => ({
      fecha,
      count
    }));

    setData({
      reservasHoy: (reservasHoy.data ?? []) as unknown as ReservaConJoin[],
      reservasMesActual: reservasMesActual.count ?? 0,
      reservasMesAnterior: reservasMesAnterior.count ?? 0,
      miembrosNuevosMesActual: miembrosMesActual.count ?? 0,
      miembrosNuevosMesAnterior: miembrosMesAnterior.count ?? 0,
      noShowsMesActual: noShowsActual.count ?? 0,
      noShowsMesAnterior: noShowsAnterior.count ?? 0,
      totalReservasMesAnteriorParaNoShows: reservasMesAnteriorTotales.count ?? 0,
      reservasUltimos30Dias
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}

/**
 * Métricas de dinero (payment_events). Suma los cobros exitosos del mes actual
 * y del anterior (para tendencia). Se leen filas y se suman en cliente: el
 * volumen de pagos por mes es bajo. Solo admin puede leer payment_events (RLS).
 */
export interface DineroMetrics {
  facturadoMesActual: number;
  facturadoMesAnterior: number;
  cobrosMesActual: number;
}

export function useDineroMetrics() {
  // El tenant lo fija el servidor (la RPC lee solo el estudio del admin).
  const [metrics, setMetrics] = useState<DineroMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const now = new Date();
    const inicioMes = inicioDeMesEnZona(0, now);
    const inicioMesAnterior = inicioDeMesEnZona(-1, now);

    // R2-B (PKG-01N): mismo origen que Reportes → el libro económico (cobros
    // FIRMES de Stripe y mostrador, por fecha del proveedor). PKG-06F (FR-62/63):
    // la base lo devuelve AGRUPADO; antes se sumaban filas crudas (tope de 1000).
    const { data, error: qErr } = await (supabase.rpc as unknown as <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { message: string } | null }>)<
      { periodo: string; clase: string; estado_evidencia: string; moneda: string; monto_centavos: number; n: number }[]
    >('libro_economico_agregado', {
      p_desde: inicioMesAnterior.toISOString(),
      p_inicio_mes_anterior: inicioMesAnterior.toISOString(),
      p_inicio_mes: inicioMes.toISOString(),
      p_hasta: new Date(now.getTime() + 60_000).toISOString()
    });

    if (qErr) {
      console.error('[useDineroMetrics]', qErr);
      setError(true);
      setIsLoading(false);
      return;
    }

    let facturadoMesActual = 0;
    let facturadoMesAnterior = 0;
    let cobrosMesActual = 0;
    for (const g of data ?? []) {
      if (g.clase !== 'cobro' || g.estado_evidencia !== 'firme' || g.moneda !== 'mxn') continue;
      if (g.periodo === 'mes') {
        facturadoMesActual += Number(g.monto_centavos);
        cobrosMesActual += Number(g.n);
      } else if (g.periodo === 'mes_anterior') {
        facturadoMesAnterior += Number(g.monto_centavos);
      }
    }

    setMetrics({ facturadoMesActual, facturadoMesAnterior, cobrosMesActual });
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { metrics, isLoading, error, refetch };
}

/**
 * Reservas en un rango de fechas para vista calendario.
 * Movido a `@shared/hooks/useReservasRango` (lo comparten admin y recepción —
 * Bloque B/C). Se re-exporta aquí por compatibilidad de imports.
 */
export { useReservasRango } from '@shared/hooks/useReservasRango';

// ============================================================================
// Mutations de gestión de usuarios (vía Netlify Functions con service_role)
// ============================================================================

export interface CreateUserParams {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  rol: 'miembro' | 'recepcionista' | 'admin';
  // slug de cualquier plan activo del tenant (no solo basica/pro).
  membresia_tier?: string | null;
}

export interface CreateUserResponse {
  success: boolean;
  user: {
    email: string;
    nombre: string;
    rol: string;
    password: string;
  };
}

export async function adminCreateUser(params: CreateUserParams) {
  return backendPost<CreateUserResponse>('admin-create-user', params);
}

export async function adminUpdateRole(params: {
  usuario_id: string;
  rol: 'miembro' | 'recepcionista' | 'admin';
}) {
  return backendPost<{ success: boolean }>('admin-update-role', params);
}

export interface AdminDeleteUserResponse {
  success: boolean;
  deleted: { id: string };
  /** `false` = el perfil ya no existe pero la cuenta de acceso del proveedor no se pudo borrar todavía. */
  acceso_eliminado?: boolean;
  aviso?: string;
}

export interface AdminDeleteUserError {
  error: string;
  /** PKG-06A: qué historial durable o huella como staff impide el borrado físico. */
  historial?: Record<string, number>;
  huella_staff?: Record<string, number>;
}

/**
 * PKG-06A (D-FIN-1 = A): el borrado físico solo procede para una cuenta sin
 * historial durable ni huella como staff; si no, el servidor responde 409 y manda
 * a "Revocar acceso". Devuelve {data,error} para que el caller surface el mensaje
 * rico del backend (qué historial lo impide).
 */
export async function adminDeleteUser(params: { usuario_id: string }): Promise<{
  data: AdminDeleteUserResponse | null;
  error: AdminDeleteUserError | null;
}> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { data: null, error: { error: 'Sesión expirada. Inicia sesión nuevamente.' } };
  }
  const res = await fetch('/.netlify/functions/admin-delete-user', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify(params)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { data: null, error: body as AdminDeleteUserError };
  }
  return { data: body as AdminDeleteUserResponse, error: null };
}
