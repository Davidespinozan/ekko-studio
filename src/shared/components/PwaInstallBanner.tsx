import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, X, Share } from 'lucide-react';

/**
 * Invita a instalar la PWA de EKKO en el teléfono / iPad.
 *   - Android/Chrome/Edge: usa el evento `beforeinstallprompt` (install nativo).
 *   - iOS Safari: no dispara ese evento → mostramos instrucciones manuales
 *     (Compartir → "Agregar a inicio").
 * No aparece si ya está instalada (display-mode standalone) o si el usuario lo
 * descartó hace poco (localStorage). Banner inferior, dismissible.
 *
 * Es una INVITACIÓN, no puede estorbar. Antes se montaba global con z-index 250
 * (por encima de los modales, z 100) y pegado al borde inferior: en la primera
 * visita desde el teléfono tapaba "Confirmar" del sheet de reserva, la barra de
 * navegación y el modal de pago; salía en login, en el checkout y hasta en
 * /admin desde Chrome de escritorio; y un descarte era para siempre. Ahora:
 *   · solo en la landing y en el inicio del miembro (`debeMostrarse`);
 *   · solo en pantallas de teléfono/tablet;
 *   · tras unos segundos, no encima de la primera impresión;
 *   · por DEBAJO de cualquier modal y por encima de la barra de navegación;
 *   · si se descarta, vuelve a invitar a los 90 días.
 */

const DISMISS_KEY = 'ekko:pwa-install-dismissed';
const REAPARECE_TRAS_MS = 90 * 24 * 60 * 60 * 1000;
const RETRASO_MS = 4000;
const ANCHO_MAX_MOVIL = 900;

/** Rutas donde invitar tiene sentido: la landing y el inicio del miembro. */
export function rutaAdmiteBanner(pathname: string): boolean {
  return pathname === '/' || pathname === '/app' || pathname === '/app/';
}

/**
 * ¿Se muestra? Pura, para poder probarla. `descartadoEn` es lo guardado en
 * localStorage: un timestamp, o el '1' del formato viejo (descarte sin fecha:
 * se respeta una vez y se migra a fecha).
 */
export function debeMostrarse(o: {
  pathname: string;
  anchoPantalla: number;
  instalada: boolean;
  descartadoEn: string | null;
  ahora?: number;
}): boolean {
  if (o.instalada) return false;
  if (!rutaAdmiteBanner(o.pathname)) return false;
  if (o.anchoPantalla > ANCHO_MAX_MOVIL) return false;
  if (o.descartadoEn) {
    const t = Number(o.descartadoEn);
    const cuando = Number.isFinite(t) && t > 1_000_000_000_000 ? t : null;
    if (cuando === null) return false; // formato viejo: se respeta
    if ((o.ahora ?? Date.now()) - cuando < REAPARECE_TRAS_MS) return false;
  }
  return true;
}

function leerDescarte(): string | null {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    // Formato viejo ('1', sin fecha): cuenta desde hoy para que algún día vuelva.
    if (v === '1') localStorage.setItem(DISMISS_KEY, String(Date.now()));
    return v;
  } catch {
    return null; // localStorage bloqueado (modo privado)
  }
}

function guardarDescarte(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* noop */
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function yaInstalada(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

function esIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
}

export default function PwaInstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iosHelp, setIosHelp] = useState(false);
  // `listo` = pasó el retraso inicial; `disponible` = hay forma de instalar.
  const [listo, setListo] = useState(false);
  const [descartado, setDescartado] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (yaInstalada()) return;

    const t = window.setTimeout(() => setListo(true), RETRASO_MS);

    if (esIOS()) {
      setVisible(true); // iOS: instrucciones manuales, sin beforeinstallprompt
      return () => window.clearTimeout(t);
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      guardarDescarte();
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function descartar() {
    setVisible(false);
    setDescartado(true);
    guardarDescarte();
  }

  async function instalar() {
    if (esIOS()) {
      setIosHelp((v) => !v);
      return;
    }
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    descartar();
  }

  if (!visible || !listo || descartado) return null;
  if (
    !debeMostrarse({
      pathname,
      anchoPantalla: window.innerWidth,
      instalada: yaInstalada(),
      descartadoEn: leerDescarte()
    })
  ) {
    return null;
  }
  // En la app del miembro hay una barra de navegación flotante abajo.
  const sobreLaNav = pathname.startsWith('/app');

  return (
    <div
      role="dialog"
      aria-label="Instalar la app de EKKO"
      style={{
        position: 'fixed',
        left: '12px',
        right: '12px',
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${sobreLaNav ? 96 : 12}px)`,
        // Por debajo de los modales (.ek-backdrop / .ek-modal-backdrop = 100):
        // nunca tapa un "Confirmar" ni un formulario de pago.
        zIndex: 60,
        maxWidth: '460px',
        margin: '0 auto',
        background: 'var(--ek-bg-elevated)',
        border: '0.5px solid var(--ek-mustard-dim)',
        borderRadius: 'var(--ek-r-md)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.5)',
        padding: '14px 14px 14px 16px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span className="ek-empty-icon" style={{ width: 40, height: 40, margin: 0, flexShrink: 0 }}>
          <Download size={18} aria-hidden="true" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '14px', fontFamily: 'var(--ek-font-display)', letterSpacing: '-0.01em' }}>
            Instala EKKO en tu teléfono
          </p>
          <p className="ek-body-muted" style={{ margin: '3px 0 0', fontSize: '12.5px', lineHeight: 1.4 }}>
            Acceso directo desde tu pantalla de inicio. Funciona como app nativa.
          </p>

          {esIOS() && iosHelp && (
            <p className="ek-body-muted" style={{ margin: '10px 0 0', fontSize: '12.5px', lineHeight: 1.5 }}>
              Toca <Share size={13} style={{ verticalAlign: '-2px', color: 'var(--ek-mustard)' }} aria-hidden="true" /> Compartir
              y luego <strong style={{ color: 'var(--ek-ink)' }}>“Agregar a inicio”</strong>.
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button
              type="button"
              className="ek-cta ek-cta--gold"
              style={{ padding: '9px 16px', fontSize: '13px', minHeight: '38px' }}
              onClick={instalar}
            >
              {esIOS() ? (iosHelp ? 'Entendido' : 'Cómo instalar') : 'Instalar'}
            </button>
            <button
              type="button"
              className="ek-cta ek-cta--secondary"
              style={{ padding: '9px 14px', fontSize: '13px', minHeight: '38px' }}
              onClick={descartar}
            >
              Ahora no
            </button>
          </div>
        </div>
        <button
          type="button"
          className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
          aria-label="Cerrar"
          onClick={descartar}
          style={{ flexShrink: 0 }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
