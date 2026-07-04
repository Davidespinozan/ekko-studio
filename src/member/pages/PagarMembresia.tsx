import { useEffect, useState } from 'react';
import { Sparkles, Check, ArrowRight, X } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { parseBeneficios } from '@shared/lib/beneficios';
import { sufijoPrecio } from '@shared/lib/planPresentacion';
import { PaymentModal } from '@shared/components/PaymentModal';
import { Spinner } from '@shared/components/Spinner';

/**
 * Pantalla para el miembro con cuenta `pendiente_pago`: paga su membresía y se
 * activa (self-serve). Arranca con el plan que eligió al registrarse, pero puede
 * CAMBIARLO aquí — la activación toma el plan del pago (metadata de la sub/PI),
 * así que pagar otro plan lo corrige. Al pagar, el webhook activa la cuenta.
 */
interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  tipo: string;
  beneficios: string[];
}

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export default function PagarMembresia() {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagarOpen, setPagarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pagado, setPagado] = useState(false);
  // null = usar el plan del signup; si el usuario elige otro, gana este.
  const [slugElegido, setSlugElegido] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, tipo, beneficios')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });
      if (!mounted) return;
      setTiers(
        (data ?? []).map((d) => ({
          slug: d.slug,
          nombre: d.nombre,
          precio_centavos: d.precio_centavos,
          tipo: d.tipo,
          beneficios: parseBeneficios(d.beneficios).filter((b) => b.incluido).map((b) => b.label).slice(0, 5)
        }))
      );
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id]);

  const slug = slugElegido ?? usuario?.membresia_tier ?? tiers[0]?.slug ?? null;
  const tier = tiers.find((t) => t.slug === slug) ?? null;
  const esPaquete = tier?.tipo === 'creditos' || tier?.tipo === 'hibrido';

  if (pagado) {
    return (
      <div style={{ maxWidth: '460px', margin: '0 auto', padding: '48px 24px', textAlign: 'center' }}>
        <span className="ek-empty-icon" style={{ width: 56, height: 56, marginBottom: '16px' }}>
          <Check size={26} aria-hidden="true" />
        </span>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '24px', fontWeight: 700, margin: '0 0 8px' }}>
          ¡Pago recibido!
        </h1>
        <p className="ek-body-muted" style={{ margin: '0 0 8px' }}>
          Estamos activando tu cuenta, puede tardar unos segundos…
        </p>
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '460px', margin: '0 auto', padding: '40px 24px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>ÚLTIMO PASO</p>
      <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
        Activa tu membresía
      </h1>
      <p className="ek-body-muted" style={{ margin: '0 0 24px' }}>
        Tu cuenta está creada. Paga tu plan para empezar a reservar.
      </p>

      {loading ? (
        <div className="ek-card"><Spinner label="Cargando planes…" /></div>
      ) : !tier ? (
        <div className="ek-card">
          <p className="ek-body-muted" style={{ margin: 0 }}>
            No hay planes disponibles. Acércate a recepción para activar tu cuenta.
          </p>
        </div>
      ) : (
        <>
          <div className="ek-card--hero" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
              <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0 }}>
                <Sparkles size={20} aria-hidden="true" />
              </span>
              <div>
                <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>TU PLAN</p>
                <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, margin: 0 }}>{tier.nombre}</h3>
              </div>
            </div>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '32px', fontWeight: 700, margin: '0 0 14px', letterSpacing: '-0.03em' }}>
              {pesos(tier.precio_centavos)}
              <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>{sufijoPrecio(tier)}</span>
            </p>
            {tier.beneficios.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {tier.beneficios.map((b, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                    <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setPagarOpen(true)}>
            Pagar ahora
          </button>

          {tiers.length > 1 && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="ek-cta ek-cta--secondary ek-cta--full"
              style={{ marginTop: '10px' }}
            >
              Cambiar de plan <ArrowRight size={15} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={signOut}
            style={{ display: 'block', margin: '14px auto 0', fontSize: '13px', color: 'var(--ek-ink-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Salir
          </button>

          {/* Selector de plan */}
          {pickerOpen && (
            <div className="ek-backdrop" onClick={() => setPickerOpen(false)} role="dialog" aria-modal="true">
              <div onClick={(e) => e.stopPropagation()} className="ek-card" style={{ maxWidth: '460px', width: '100%', maxHeight: '86vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>ELIGE TU PLAN</p>
                  <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={() => setPickerOpen(false)}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {tiers.map((t) => {
                    const seleccionado = t.slug === slug;
                    return (
                      <button
                        key={t.slug}
                        type="button"
                        onClick={() => { setSlugElegido(t.slug); setPickerOpen(false); }}
                        className="ek-card ek-card--md ek-card--cream"
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', textAlign: 'left', cursor: 'pointer', border: seleccionado ? '1.5px solid var(--ek-mustard)' : undefined }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(10, 10, 10, 0.6)' }}>{t.nombre}</span>
                          <p style={{ margin: '2px 0 0', fontWeight: 700, color: 'var(--ek-bg)' }}>
                            {pesos(t.precio_centavos)}<span style={{ color: 'rgba(10, 10, 10, 0.55)', fontWeight: 500, fontSize: '13px' }}>{sufijoPrecio(t)}</span>
                          </p>
                        </div>
                        {seleccionado
                          ? <Check size={18} style={{ color: 'var(--ek-bg)', flexShrink: 0 }} aria-hidden="true" />
                          : <ArrowRight size={16} style={{ color: 'var(--ek-bg)', flexShrink: 0 }} aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {pagarOpen && (
            <PaymentModal
              tierSlug={tier.slug}
              tierNombre={tier.nombre}
              precio={Math.round(tier.precio_centavos / 100)}
              esPaquete={esPaquete}
              onClose={() => setPagarOpen(false)}
              onPagado={() => {
                setPagarOpen(false);
                setPagado(true);
                // El webhook activa la cuenta; recargamos para entrar activo.
                setTimeout(() => window.location.reload(), 4500);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
