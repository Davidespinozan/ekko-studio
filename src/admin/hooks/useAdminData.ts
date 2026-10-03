import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { backendPost } from '@shared/lib/backend';
import { inicioDeHoyEnZona, inicioDeMesEnZona, fechaISOEnZona } from '@shared/lib/timezone';
import type { Database } from '@shared/types/database';

type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];
type Tier = Database['public']['Tables']['tiers']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

export interface MiembroRow extends Usuario {
  reservas_count?: number;
}

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
}

/**
 * Lista de miembros del tenant (sin paginación por simplicidad inicial).
 */
export function useMiembros(filtros?: { search?: string; status?: string; rol?: string | 'staff' }) {
  const tenant = useTenant();
  const [miembros, setMiembros] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): un fallo de la consulta no es "todavía no hay miembros".
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    let query = supabase
      .from('usuarios')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });

    if (filtros?.status) query = query.eq('status', filtros.status);

    // Filtro especial "staff" = todos los no-miembros (recepcionista, staff, admin)
    if (filtros?.rol === 'staff') {
      query = query.in('rol', ['recepcionista', 'staff', 'admin']);
    } else if (filtros?.rol) {
      query = query.eq('rol', filtros.rol);
    }

    if (filtros?.search) {
      const term = `%${filtros.search}%`;
      query = query.or(`nombre.ilike.${term},email.ilike.${term}`);
    }

    const { data, error: qErr } = await query;
    if (qErr) {
      console.error('[useMiembros]', qErr);
      setError(true); // la lista anterior se conserva
      setIsLoading(false);
      return;
    }
    setMiembros(data ?? []);
    setIsLoading(false);
  }, [tenant.id, filtros?.search, filtros?.status, filtros?.rol]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembros, isLoading, error, refetch };
}

/**
 * Detalle de 1 miembro con sus reservas.
 */
export function useMiembroDetalle(miembroId: string | undefined) {
  const [miembro, setMiembro] = useState<Usuario | null>(null);
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!miembroId) return;
    setIsLoading(true);

    const [m, r] = await Promise.all([
      supabase.from('usuarios').select('*').eq('id', miembroId).maybeSingle(),
      supabase
        .from('reservas')
        .select('*, recurso:recursos(id, slug, nombre)')
        .eq('usuario_id', miembroId)
        .order('slot_inicio', { ascending: false })
        .limit(50)
    ]);

    setMiembro(m.data);
    setReservas((r.data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [miembroId]);

  useEffect(() => { refetch(); }, [refetch]);
  return { miembro, reservas, isLoading, refetch };
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
      const { data, error: qErr } = await supabase
        .from('membresias')
        .select('usuario_id, status, periodo_actual_fin, creditos_restantes, created_at, tier:tiers(slug, nombre, tipo)')
        .eq('tenant_id', tenant.id)
        .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
        .order('created_at', { ascending: false });
      if (qErr) {
        console.error('[useMembresiasVigentesPorUsuario]', qErr);
        setError(true); // el mapa anterior se conserva
        return;
      }
      const map = new Map<string, MembresiaResumen>();
      for (const m of (data ?? []) as unknown as MembresiaResumen[]) {
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

/**
 * Actualizar campos arbitrarios de un miembro.
 * RLS valida que solo admin del tenant puede hacerlo.
 */
export async function updateMiembro(
  miembroId: string,
  patch: Partial<Pick<Usuario, 'rol' | 'status' | 'membresia_tier' | 'nombre' | 'telefono'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('usuarios').update(patch).eq('id', miembroId);
  return { error: error?.message ?? null };
}

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
  return { error: error?.message ?? null };
}

export async function insertTier(
  payload: Database['public']['Tables']['tiers']['Insert']
): Promise<{ error: string | null; data: Tier | null }> {
  const { data, error } = await supabase
    .from('tiers')
    .insert(payload)
    .select('*')
    .single();
  return { error: error?.message ?? null, data: (data as Tier | null) ?? null };
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
          .select('*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
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
          '*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)'
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
      supabase
        .from('reservas')
        .select('slot_inicio')
        .eq('tenant_id', tenant.id)
        .neq('status', 'cancelada')
        .neq('status', 'cancelada_admin')
        .gte('slot_inicio', hace30dias.toISOString())
        .lt('slot_inicio', finHoy.toISOString())
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
    (reservas30d.data ?? []).forEach((r) => {
      const k = fechaISOEnZona(String(r.slot_inicio));
      if (k in conteoPorDia) conteoPorDia[k]++;
    });
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
  const tenant = useTenant();
  const [metrics, setMetrics] = useState<DineroMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const now = new Date();
    const inicioMes = inicioDeMesEnZona(0, now);
    const inicioMesAnterior = inicioDeMesEnZona(-1, now);

    const { data, error: qErr } = await supabase
      .from('payment_events')
      .select('monto_centavos, created_at')
      .eq('tenant_id', tenant.id)
      .eq('status', 'succeeded')
      .gte('created_at', inicioMesAnterior.toISOString());

    if (qErr) {
      console.error('[useDineroMetrics]', qErr);
      setError(true);
      setIsLoading(false);
      return;
    }

    let facturadoMesActual = 0;
    let facturadoMesAnterior = 0;
    let cobrosMesActual = 0;
    for (const row of data ?? []) {
      const monto = row.monto_centavos ?? 0;
      const fecha = new Date(row.created_at);
      if (fecha >= inicioMes) {
        facturadoMesActual += monto;
        cobrosMesActual += 1;
      } else {
        facturadoMesAnterior += monto;
      }
    }

    setMetrics({ facturadoMesActual, facturadoMesAnterior, cobrosMesActual });
    setIsLoading(false);
  }, [tenant.id]);

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
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
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
  rol: 'miembro' | 'recepcionista' | 'staff' | 'admin';
}) {
  return backendPost<{ success: boolean }>('admin-update-role', params);
}

export interface AdminDeleteUserResponse {
  success: boolean;
  deleted: { id: string; email: string; nombre?: string | null };
}

export interface AdminDeleteUserError {
  error: string;
  reservas_count?: number;
}

/**
 * Hard delete: borra de auth.users → cascadea a public.usuarios,
 * notificaciones, membresias. Bloquea (409) si target tiene reservas.
 * Devuelve {data,error} para que el caller surface el mensaje rico
 * del backend (ej. "tiene N reservas").
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
