import { useEffect, useState } from 'react';
import { Sparkles, Check } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { parseBeneficios } from '@shared/lib/beneficios';
import { PaymentModal } from '@shared/components/PaymentModal';
import { Spinner } from '@shared/components/Spinner';

/**
 * Pantalla para el miembro con cuenta `pendiente_pago`: paga su membresía y se
 * activa (self-serve). El plan es el que eligió al registrarse
 * (`usuarios.membresia_tier`). Al pagar, el webhook activa la cuenta en unos
 * segundos → recargamos para entrar al app ya activo.
 */
interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  tipo: string;
  beneficios: string[];
}

export default function PagarMembresia() {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const [tier, setTier] = useState<TierInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [pagarOpen, setPagarOpen] = useState(false);
  const [pagado, setPagado] = useState(false);

  const slug = usuario?.membresia_tier ?? null;

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!slug) { setLoading(false); return; }
      const { data } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, tipo, beneficios')
        .eq('tenant_id', tenant.id)
        .eq('slug', slug)
        .maybeSingle();
      if (!mounted) return;
      if (data) {
        setTier({
          slug: data.slug,
          nombre: data.nombre,
          precio_centavos: data.precio_centavos,
          tipo: data.tipo,
          beneficios: parseBeneficios(data.beneficios).filter((b) => b.incluido).map((b) => b.label).slice(0, 5)
        });
      }
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slug, tenant.id]);

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
        Activá tu membresía
      </h1>
      <p className="ek-body-muted" style={{ margin: '0 0 24px' }}>
        Tu cuenta está creada. Pagá tu plan para empezar a reservar.
      </p>

      {loading ? (
        <div className="ek-card"><Spinner label="Cargando tu plan…" /></div>
      ) : !tier ? (
        <div className="ek-card">
          <p className="ek-body-muted" style={{ margin: 0 }}>
            No encontramos tu plan. Acercate a recepción para activar tu cuenta.
          </p>
        </div>
      ) : (
        <>
          <div className="ek-card--hero" style={{ marginBottom: '20px' }}>
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
              ${Math.round(tier.precio_centavos / 100).toLocaleString('es-MX')}
              <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>{esPaquete ? ' · pago único' : '/mes'}</span>
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
          <button
            type="button"
            onClick={signOut}
            style={{ display: 'block', margin: '14px auto 0', fontSize: '13px', color: 'var(--ek-ink-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Salir
          </button>

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
