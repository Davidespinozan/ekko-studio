import { useEffect, useState } from 'react';
import { Sparkles, Check, CreditCard, ArrowRight, X, MessageCircle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { TierBadge } from '@shared/components/TierBadge';
import { EmptyState } from '@shared/components/EmptyState';
import { Spinner } from '@shared/components/Spinner';

interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: string[];
  descripcion: string | null;
}

interface PagoInfo {
  id: string;
  monto_centavos: number | null;
  moneda: string | null;
  status: string | null;
  created_at: string;
}

function parseBeneficios(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((b): b is string => typeof b === 'string');
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter((b): b is string => typeof b === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

function getWhatsappNumber(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const contacto = (config as Record<string, unknown>).contacto;
  if (!contacto || typeof contacto !== 'object') return null;
  const numero = (contacto as Record<string, unknown>).whatsapp_e164;
  if (typeof numero !== 'string') return null;
  const limpio = numero.replace(/\D/g, '');
  return limpio.length >= 10 ? limpio : null;
}

const STATUS_META: Record<string, { texto: string; clase: string }> = {
  activa: { texto: 'Activa', clase: 'ek-badge--success' },
  active: { texto: 'Activa', clase: 'ek-badge--success' },
  pendiente_pago: { texto: 'Pendiente de pago', clase: 'ek-badge--outline' },
  suspendida: { texto: 'Suspendida', clase: 'ek-badge--danger' },
  cancelada: { texto: 'Cancelada', clase: 'ek-badge--danger' }
};

interface Props {
  usuarioId: string;
  tierSlug: string | null;
  status: string | null | undefined;
  nombre: string | null | undefined;
}

export function MiSuscripcion({ usuarioId, tierSlug, status, nombre }: Props) {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [pagos, setPagos] = useState<PagoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [cambiarOpen, setCambiarOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [tiersRes, pagosRes] = await Promise.all([
        supabase
          .from('tiers')
          .select('slug, nombre, precio_centavos, beneficios, descripcion')
          .eq('tenant_id', tenant.id)
          .eq('activo', true)
          .order('precio_centavos', { ascending: true }),
        supabase
          .from('payment_events')
          .select('id, monto_centavos, moneda, status, created_at')
          .eq('usuario_id', usuarioId)
          .order('created_at', { ascending: false })
          .limit(12)
      ]);
      if (!mounted) return;
      setTiers(
        (tiersRes.data ?? []).map((t) => ({
          slug: t.slug,
          nombre: t.nombre,
          precio_centavos: t.precio_centavos,
          beneficios: parseBeneficios(t.beneficios),
          descripcion: t.descripcion
        }))
      );
      setPagos((pagosRes.data ?? []) as PagoInfo[]);
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, usuarioId]);

  const planActual = tiers.find((t) => t.slug === tierSlug) ?? null;
  const statusMeta = STATUS_META[status ?? ''] ?? { texto: status ?? '—', clase: 'ek-badge--neutral' };
  const whatsapp = getWhatsappNumber(tenant.config);

  function solicitarCambio(destino: TierInfo) {
    const msg = `Hola, soy ${nombre ?? 'un miembro'}. Quiero cambiar mi membresía a ${destino.nombre} (${formatearPesos(destino.precio_centavos)}/mes).`;
    if (whatsapp) {
      window.open(`https://wa.me/${whatsapp}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
    }
    setCambiarOpen(false);
  }

  return (
    <section>
      <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '14px' }}>
        MI SUSCRIPCIÓN
      </p>

      {loading ? (
        <div className="ek-card"><Spinner size={18} label="Cargando tu plan…" /></div>
      ) : (
        <>
          {/* Plan actual */}
          <div className="ek-card--hero" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="ek-empty-icon" style={{ width: 48, height: 48, margin: 0 }}>
                  <Sparkles size={22} aria-hidden="true" />
                </span>
                <div>
                  <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>PLAN ACTUAL</p>
                  <h3 style={{
                    fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700,
                    margin: 0, letterSpacing: '-0.02em'
                  }}>
                    {planActual?.nombre ?? (tierSlug ?? 'Sin plan')}
                  </h3>
                </div>
              </div>
              {planActual && <TierBadge pro={planActual.slug === 'pro'} />}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' }}>
              {planActual && (
                <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '34px', fontWeight: 700, margin: 0, letterSpacing: '-0.03em' }}>
                  {formatearPesos(planActual.precio_centavos)}
                  <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span>
                </p>
              )}
              <span className={`ek-badge ${statusMeta.clase}`}>{statusMeta.texto}</span>
            </div>

            {planActual && planActual.beneficios.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {planActual.beneficios.map((b) => (
                  <li key={b} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                    <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                    {b}
                  </li>
                ))}
              </ul>
            )}

            <button type="button" className="ek-cta ek-cta--full" onClick={() => setCambiarOpen(true)}>
              Cambiar de plan <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>

          {/* Método de pago e historial */}
          <div className="ek-card">
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>PAGOS</p>
            {pagos.length === 0 ? (
              <EmptyState
                icon={CreditCard}
                tone="neutral"
                title="Sin pagos registrados"
                hint="Tu método de pago y el historial de cobros aparecerán aquí cuando el estudio active la pasarela de pago."
              />
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {pagos.map((p) => (
                  <li key={p.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    paddingBottom: '10px', borderBottom: '0.5px solid var(--ek-line)'
                  }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
                        {p.monto_centavos != null ? formatearPesos(p.monto_centavos) : '—'}
                        {p.moneda ? ` ${p.moneda.toUpperCase()}` : ''}
                      </p>
                      <p className="ek-body-faint" style={{ margin: 0 }}>
                        {new Date(p.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <span className={`ek-badge ${p.status === 'succeeded' || p.status === 'paid' ? 'ek-badge--success' : 'ek-badge--neutral'}`}>
                      {p.status ?? '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* Modal cambiar de plan */}
      {cambiarOpen && (
        <div className="ek-backdrop" onClick={() => setCambiarOpen(false)} role="dialog" aria-modal="true">
          <div
            className="ek-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '440px', width: '100%', maxHeight: '88vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <p className="ek-eyebrow ek-eyebrow--mustard">CAMBIAR DE PLAN</p>
              <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={() => setCambiarOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: '18px' }}>
              Elegí tu nuevo plan y coordinamos el cambio por WhatsApp.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {tiers.map((t) => {
                const esActual = t.slug === tierSlug;
                return (
                  <div key={t.slug} className="ek-card ek-card--md" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <TierBadge pro={t.slug === 'pro'} />
                        {esActual && <span className="ek-badge ek-badge--neutral">Actual</span>}
                      </div>
                      <p style={{ margin: 0, fontWeight: 600 }}>
                        {formatearPesos(t.precio_centavos)}<span style={{ color: 'var(--ek-ink-muted)', fontWeight: 500, fontSize: '13px' }}>/mes</span>
                      </p>
                    </div>
                    {!esActual && (
                      <button
                        type="button"
                        className="ek-cta"
                        style={{ padding: '10px 16px', fontSize: '13px' }}
                        onClick={() => solicitarCambio(t)}
                        disabled={!whatsapp}
                      >
                        <MessageCircle size={15} aria-hidden="true" /> Solicitar
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {!whatsapp && (
              <p className="ek-helper-text" style={{ marginTop: '14px' }}>
                El estudio aún no configuró su WhatsApp de contacto.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
