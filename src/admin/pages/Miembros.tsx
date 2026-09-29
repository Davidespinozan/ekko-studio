import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Users, ArrowRight, Download, X } from 'lucide-react';
import { useMiembros, useMembresiasVigentesPorUsuario, type MembresiaResumen } from '../hooks/useAdminData';
import { estadoMembresia, ESTADO_MEMBRESIA_LABEL, esPaqueteDeCreditos } from '@shared/lib/membresiaEstado';
import { formatFechaEnZona } from '@shared/lib/timezone';
import { exportarCsv } from '@shared/lib/exportarCsv';
import { NuevaPersonaModal } from '../components/NuevaPersonaModal';
import { Spinner } from '@shared/components/Spinner';
import { EmptyState } from '@shared/components/EmptyState';
import { ErrorCarga, ErrorInline } from '@shared/components/ErrorCarga';

export default function Miembros() {
  // La lista se puede abrir ya filtrada (?status=… / ?filtro=vencidas|identidad): así
  // el centro de pendientes del dashboard lleva a QUIÉNES son, no a una lista general.
  const [params, setParams] = useSearchParams();
  const filtro = params.get('filtro');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(params.get('status') ?? '');
  const [showNuevo, setShowNuevo] = useState(false);
  // Fijamos rol='miembro' para excluir staff (admins, recepcionistas).
  // El equipo se gestiona desde /admin/equipo (Sprint Equipo).
  const { miembros: todos, isLoading, error: errorMiembros, refetch } = useMiembros({ search, status, rol: 'miembro' });
  // PKG-02A (C02): si las membresías no cargaron, la columna dice "no disponible"
  // (no "SIN MEMBRESÍA" para todos) y el filtro por vencidas no se evalúa.
  const { porUsuario, error: errorMembresias, refetch: refetchMembresias } = useMembresiasVigentesPorUsuario();

  const FILTROS: Record<string, { texto: string; pasa: (m: (typeof todos)[number]) => boolean }> = {
    vencidas: {
      texto: 'Membresía vencida',
      pasa: (m) => estadoMembresia(porUsuario.get(m.id) ?? null) === 'vencida'
    },
    identidad: {
      texto: 'Identidad por capturar',
      pasa: (m) => m.status === 'activo' && !(m.identidad_completa && m.contrato_firmado)
    }
  };
  const filtroActivo = filtro ? FILTROS[filtro] : undefined;
  // El filtro "vencidas" depende de las membresías: con error no se puede calcular.
  const filtroSinDatos = filtro === 'vencidas' && errorMembresias;
  const miembros = filtroActivo && !filtroSinDatos ? todos.filter(filtroActivo.pasa) : todos;
  const hayFiltros = Boolean(search || status || filtroActivo);

  function limpiarFiltros() {
    setSearch('');
    setStatus('');
    setParams({}, { replace: true });
  }

  const vigentes = miembros.filter((m) => {
    const e = estadoMembresia(porUsuario.get(m.id) ?? null);
    return e === 'vigente' || e === 'por_vencer' || e === 'pago_pendiente';
  }).length;

  function exportar() {
    exportarCsv(`miembros-${new Date().toISOString().slice(0, 10)}`, miembros, [
      { key: 'nombre', label: 'Nombre' },
      { key: 'email', label: 'Email' },
      { key: 'telefono', label: 'Teléfono' },
      { key: 'membresia_tier', label: 'Plan asignado' },
      { key: 'membresia', label: 'Membresía', valor: (m) => (errorMembresias ? 'NO DISPONIBLE' : ESTADO_MEMBRESIA_LABEL[estadoMembresia(porUsuario.get(m.id) ?? null)].texto) },
      { key: 'vence', label: 'Vence / créditos', valor: (m) => (errorMembresias ? '' : detalleMembresia(porUsuario.get(m.id) ?? null)) },
      { key: 'status', label: 'Status de cuenta' },
      { key: 'no_shows_count', label: 'Inasistencias' },
      { key: 'created_at', label: 'Alta', valor: (m) => formatFechaEnZona(m.created_at, { year: 'numeric', month: '2-digit', day: '2-digit' }) }
    ]);
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: '12px'
        }}
      >
        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard">MIEMBROS</p>
          <h1 className="ek-h2">Tus clientes en EKKO</h1>
          {!isLoading && !errorMiembros && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {miembros.length}{' '}
              {miembros.length === 1 ? 'cliente' : 'clientes'}
              {errorMembresias ? ' · membresías no disponibles' : ` · ${vigentes} con membresía vigente`}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={exportar}
            disabled={miembros.length === 0}
            className="ek-cta ek-cta--secondary"
            title="Descargar la lista filtrada como CSV (Excel)"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Download size={15} aria-hidden="true" /> Exportar CSV
          </button>
          <button onClick={() => setShowNuevo(true)} className="ek-cta">
            + Nuevo miembro
          </button>
        </div>
      </div>

      <div className="adm-filters">
        <input
          type="text"
          placeholder="Buscar por nombre o email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '280px' }}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '180px' }}
        >
          <option value="">Todos los status</option>
          <option value="activo">Activo</option>
          <option value="pendiente_onboarding">Pendiente onboarding</option>
          <option value="pendiente_pago">Pendiente pago</option>
          <option value="suspendido">Suspendido</option>
          <option value="cancelado">Cancelado</option>
        </select>
        {filtroActivo && (
          <button
            type="button"
            className="ek-badge ek-badge--outline"
            onClick={() => setParams({}, { replace: true })}
            aria-label={`Quitar filtro: ${filtroActivo.texto}`}
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            {filtroActivo.texto} <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {errorMembresias && !errorMiembros && !isLoading && (
        <div style={{ marginBottom: '12px' }}>
          <ErrorInline
            mensaje={filtroSinDatos
              ? 'No pudimos cargar las membresías: el filtro "Membresía vencida" no se puede aplicar. Se muestra la lista completa.'
              : 'No pudimos cargar las membresías. La columna Membresía no está disponible.'}
            onReintentar={() => void refetchMembresias()}
          />
        </div>
      )}

      {errorMiembros ? (
        <ErrorCarga titulo="No pudimos cargar los miembros." onReintentar={() => void refetch()} />
      ) : isLoading ? (
        <Spinner label="Cargando…" />
      ) : miembros.length === 0 ? (
        hayFiltros ? (
          <EmptyState
            icon={Users}
            title="Sin resultados"
            hint="Ningún miembro coincide con la búsqueda o los filtros."
            tone="neutral"
            action={<button type="button" className="ek-cta ek-cta--secondary" onClick={limpiarFiltros}>Limpiar filtros</button>}
          />
        ) : (
          // Base vacía ≠ búsqueda sin resultados: un estudio nuevo leía "no hay
          // miembros que coincidan con tu búsqueda" sin haber buscado nada.
          <EmptyState
            icon={Users}
            title="Todavía no hay miembros"
            hint="Se registran solos desde la app, o los das de alta tú."
            tone="neutral"
            action={<button type="button" className="ek-cta ek-cta--gold" onClick={() => setShowNuevo(true)}>+ Nuevo miembro</button>}
          />
        )
      ) : (
        <>
        {/* Móvil: tarjetas apiladas (la tabla no entra en pantallas chicas). */}
        <div className="adm-cards-mobile">
          {miembros.map((m) => (
            <Link
              key={m.id}
              to={`/admin/miembros/${m.id}`}
              className="adm-card adm-card--interactive"
              style={{
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                textDecoration: 'none',
                color: 'inherit'
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{m.nombre ?? '—'}</p>
                <p
                  style={{
                    margin: '2px 0 0',
                    fontSize: '12px',
                    color: 'var(--ek-ink-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {m.email}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: 'var(--ek-ink-muted)'
                    }}
                  >
                    {m.membresia_tier ?? 'sin plan'}
                  </span>
                  <MembresiaCelda m={porUsuario.get(m.id) ?? null} noDisponible={errorMembresias} />
                  <StatusBadge status={m.status} />
                </div>
              </div>
              <ArrowRight size={16} aria-hidden="true" style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} />
            </Link>
          ))}
        </div>

        {/* Desktop: tabla */}
        <div className="adm-table-wrapper adm-table-desktop">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Membresía</th>
                <th>Status</th>
                <th>Alta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {miembros.map((m) => (
                <tr key={m.id}>
                  <td>{m.nombre ?? '—'}</td>
                  <td style={{ color: 'var(--ek-ink-muted)' }}>{m.email}</td>
                  <td>{m.membresia_tier ?? '—'}</td>
                  <td>
                    <MembresiaCelda m={porUsuario.get(m.id) ?? null} noDisponible={errorMembresias} />
                  </td>
                  <td>
                    <StatusBadge status={m.status} />
                  </td>
                  <td style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)' }}>
                    {new Date(m.created_at).toLocaleDateString('es-MX')}
                  </td>
                  <td>
                    <Link
                      to={`/admin/miembros/${m.id}`}
                      className="adm-link"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      Ver
                      <ArrowRight size={13} aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {showNuevo && (
        <NuevaPersonaModal
          onClose={() => setShowNuevo(false)}
          onCreated={async () => {
            await refetch();
            setShowNuevo(false);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    activo: 'var(--ek-success)',
    pendiente_onboarding: 'var(--ek-warning)',
    pendiente_pago: 'var(--ek-warning)',
    suspendido: 'var(--ek-danger)',
    cancelado: 'var(--ek-ink-muted)'
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem' }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: colorMap[status] ?? 'var(--ek-ink-muted)'
        }}
      />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function detalleMembresia(m: MembresiaResumen | null): string {
  if (!m) return '';
  if (esPaqueteDeCreditos(m.tier?.tipo)) return `${m.creditos_restantes ?? 0} créditos`;
  return m.periodo_actual_fin ? formatFechaEnZona(m.periodo_actual_fin, { day: 'numeric', month: 'short' }) : '';
}

/** Estado de la membresía derivado por fecha (no el status de la cuenta). */
function MembresiaCelda({ m, noDisponible = false }: { m: MembresiaResumen | null; noDisponible?: boolean }) {
  // PKG-02A: la consulta de membresías falló → no se afirma ausencia.
  if (noDisponible) {
    return (
      <span title="No pudimos cargar las membresías" style={{ color: 'var(--ek-danger)', fontWeight: 700, fontSize: '11px', letterSpacing: '0.06em' }}>
        NO DISPONIBLE
      </span>
    );
  }
  const estado = estadoMembresia(m);
  const { texto, color } = ESTADO_MEMBRESIA_LABEL[estado];
  const detalle = detalleMembresia(m);
  return (
    <span
      title={m?.tier?.nombre ? `${m.tier.nombre}${detalle ? ` · ${detalle}` : ''}` : undefined}
      style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.2 }}
    >
      <span style={{ color, fontWeight: 700, fontSize: '11px', letterSpacing: '0.06em' }}>{texto}</span>
      {detalle && <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>{detalle}</span>}
    </span>
  );
}
