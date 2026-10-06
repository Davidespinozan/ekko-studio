import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Ban, Trash2, UserPlus, KeyRound } from 'lucide-react';
import { ResetPasswordModal } from '@reception/components/ResetPasswordModal';
import { supabase } from '@shared/lib/supabase';
import { COLUMNAS_USUARIO_CLIENTE, type UsuarioCliente } from '@shared/lib/columnas';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { backendPost } from '@shared/lib/backend';
import { Spinner } from '@shared/components/Spinner';
import { EmptyState } from '@shared/components/EmptyState';
import { ErrorCarga } from '@shared/components/ErrorCarga';
import { canModifyTeamMember, revokeTeamMember } from '../lib/crudHelpers';
import { adminDeleteUser } from '../hooks/useAdminData';
import CardMenuDropdown from '../components/CardMenuDropdown';
import ConfirmDialog from '../components/ConfirmDialog';
import CrearAccesoModal, { type CredencialesCreadas } from '../components/CrearAccesoModal';
import CredencialesCreadasModal from '../components/CredencialesCreadasModal';
import CambiarRolModal from '../components/CambiarRolModal';

type Usuario = UsuarioCliente;
type RolStaff = 'admin' | 'recepcionista';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function rolLabel(rol: string): string {
  if (rol === 'admin') return 'Administrador';
  if (rol === 'recepcionista') return 'Recepcionista';
  return rol;
}

type RevokeState = null | { usuario: Usuario; status: 'loading' | 'blocked'; reason?: string } | { usuario: Usuario; status: 'ready' };

export default function Equipo() {
  const tenant = useTenant();
  const { usuario: currentUser } = useAuth();
  const toast = useToast();

  const [staff, setStaff] = useState<Usuario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);
  const [showCrearAcceso, setShowCrearAcceso] = useState(false);
  const [credencialesCreadas, setCredencialesCreadas] = useState<CredencialesCreadas | null>(null);
  const [cambioRol, setCambioRol] = useState<{ usuario: Usuario; rol: RolStaff } | null>(null);
  const [revoke, setRevoke] = useState<RevokeState>(null);
  const [hardDelete, setHardDelete] = useState<Usuario | null>(null);
  // Resetear la contraseña de alguien del equipo (el backend ya lo permite a un admin).
  const [resetDe, setResetDe] = useState<Usuario | null>(null);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('usuarios')
      .select(COLUMNAS_USUARIO_CLIENTE)
      .eq('tenant_id', tenant.id)
      .in('rol', ['admin', 'recepcionista'])
      .neq('status', 'revocado')
      .order('rol', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Equipo]', error);
      // PKG-02A: estado de error explícito (antes: toast + "Sin personas con acceso todavía").
      setErrorCarga(true);
      setIsLoading(false);
      return;
    }
    setErrorCarga(false);
    setStaff((data ?? []) as unknown as Usuario[]);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const { admins, recepcionistas } = useMemo(() => {
    const admins: Usuario[] = [];
    const recepcionistas: Usuario[] = [];

    staff.forEach((u) => {
      if (u.rol === 'admin') admins.push(u);
      else if (u.rol === 'recepcionista') recepcionistas.push(u);
    });

    return { admins, recepcionistas };
  }, [staff]);

  const conAcceso = admins.length + recepcionistas.length;

  async function startRevoke(u: Usuario) {
    if (!currentUser) return;
    setRevoke({ usuario: u, status: 'loading' });
    const check = await canModifyTeamMember(
      u.id,
      currentUser.id,
      u.rol as RolStaff,
      'revoke',
      tenant.id
    );
    if (!check.canModify) {
      setRevoke({ usuario: u, status: 'blocked', reason: check.reason });
    } else {
      setRevoke({ usuario: u, status: 'ready' });
    }
  }

  async function handleRevoke() {
    if (!revoke || revoke.status !== 'ready') return;
    const { error } = await revokeTeamMember(revoke.usuario.id);
    if (error) {
      toast.error(`No se pudo revocar: ${error}`);
      return;
    }
    toast.success(`Acceso revocado para ${capitalizar(revoke.usuario.nombre) || revoke.usuario.email}.`);
    setRevoke(null);
    await refetch();
  }

  async function handleHardDelete() {
    if (!hardDelete) return;
    const { data, error } = await adminDeleteUser({ usuario_id: hardDelete.id });
    if (error) {
      toast.error(error.error || 'No se pudo eliminar');
      return;
    }
    // PKG-06A: si el proveedor de acceso no respondió, el perfil ya no existe y se dice.
    if (data?.acceso_eliminado === false) toast.error(data.aviso ?? 'El perfil se eliminó; la cuenta de acceso quedó pendiente.');
    else toast.success(`${capitalizar(hardDelete.nombre) || hardDelete.email} fue eliminado.`);
    setHardDelete(null);
    await refetch();
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard">EQUIPO</p>
          <h1 className="ek-h2">Personas con acceso a EKKO admin</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {conAcceso} {conAcceso === 1 ? 'persona con acceso' : 'personas con acceso'}
            </p>
          )}
        </div>
        <button onClick={() => setShowCrearAcceso(true)} className="ek-cta">
          + Crear acceso
        </button>
      </div>

      <CuentasDemo />

      {errorCarga ? (
        <ErrorCarga titulo="No pudimos cargar el equipo." onReintentar={() => void refetch()} />
      ) : isLoading ? (
        <Spinner label="Cargando…" />
      ) : (
        <div className="adm-stack" style={{ gap: '32px' }}>
          {admins.length > 0 && (
            <Section title="ADMINISTRADORES">
              {admins.map((u) => (
                <PersonaCard
                  key={u.id}
                  usuario={u}
                  currentUserId={currentUser?.id}
                  onCambiarRol={() => setCambioRol({ usuario: u, rol: 'admin' })}
                  onRevoke={() => startRevoke(u)}
                  onHardDelete={() => setHardDelete(u)}
                  onResetPassword={() => setResetDe(u)}
                />
              ))}
            </Section>
          )}

          {recepcionistas.length > 0 && (
            <Section title="RECEPCIONISTAS">
              {recepcionistas.map((u) => (
                <PersonaCard
                  key={u.id}
                  usuario={u}
                  currentUserId={currentUser?.id}
                  onCambiarRol={() => setCambioRol({ usuario: u, rol: 'recepcionista' })}
                  onRevoke={() => startRevoke(u)}
                  onHardDelete={() => setHardDelete(u)}
                  onResetPassword={() => setResetDe(u)}
                />
              ))}
            </Section>
          )}

          {admins.length === 0 && recepcionistas.length === 0 && (
            <EmptyState
              icon={UserPlus}
              title="Sin personas con acceso todavía."
              hint='Click en "+ Crear acceso" para empezar.'
              action={
                <button onClick={() => setShowCrearAcceso(true)} className="ek-cta">
                  + Crear acceso
                </button>
              }
            />
          )}
        </div>
      )}

      {showCrearAcceso && (
        <CrearAccesoModal
          onClose={() => setShowCrearAcceso(false)}
          onSuccess={async (cred) => {
            setCredencialesCreadas(cred);
            await refetch();
          }}
        />
      )}

      {credencialesCreadas && (
        <CredencialesCreadasModal
          isOpen={true}
          credenciales={credencialesCreadas}
          onClose={() => setCredencialesCreadas(null)}
        />
      )}

      {cambioRol && (
        <CambiarRolModal
          usuarioId={cambioRol.usuario.id}
          nombre={capitalizar(cambioRol.usuario.nombre) || cambioRol.usuario.email}
          rolActual={cambioRol.rol}
          onClose={() => setCambioRol(null)}
          onSaved={async () => {
            await refetch();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={revoke !== null}
        title={revoke ? `¿Revocar acceso de ${capitalizar(revoke.usuario.nombre) || revoke.usuario.email}?` : ''}
        description={
          revoke?.status === 'loading'
            ? 'Verificando permisos…'
            : revoke?.status === 'blocked'
            ? revoke.reason ?? 'No se puede revocar.'
            : 'No podrá entrar al sistema. Sus datos quedan en BD para auditoría. Puedes restaurar el acceso después.'
        }
        confirmLabel="Revocar acceso"
        variant={revoke?.status === 'blocked' ? 'danger' : 'warning'}
        hideConfirm={revoke?.status !== 'ready'}
        requireTypedConfirmation={revoke?.status === 'ready' ? 'REVOCAR' : undefined}
        onConfirm={handleRevoke}
        onCancel={() => setRevoke(null)}
      />

      <ConfirmDialog
        isOpen={hardDelete !== null}
        title={hardDelete ? `¿Eliminar definitivamente a ${capitalizar(hardDelete.nombre) || hardDelete.email}?` : ''}
        description="Hard delete: borra la cuenta de Auth y todos los datos de la BD. Libera el email para volver a invitarse. Acción irreversible. Si tiene reservas en historial, el backend va a bloquear la operación. Escribe ELIMINAR para confirmar."
        confirmLabel="Eliminar definitivamente"
        variant="danger"
        requireTypedConfirmation="ELIMINAR"
        onConfirm={handleHardDelete}
        onCancel={() => setHardDelete(null)}
      />

      {resetDe && (
        <ResetPasswordModal
          miembroId={resetDe.id}
          miembroNombre={capitalizar(resetDe.nombre) || resetDe.email}
          onClose={() => setResetDe(null)}
        />
      )}
    </div>
  );
}

interface DemoResultado {
  password: string;
  cuentas: { email: string; rol: string; nombre: string }[];
}

/** Cuentas demo (una por rol) para que el dueño pruebe cada rol con auth real. */
function CuentasDemo() {
  const toast = useToast();
  const [creando, setCreando] = useState(false);
  const [res, setRes] = useState<DemoResultado | null>(null);

  async function crear() {
    setCreando(true);
    try {
      const r = await backendPost<DemoResultado & { success: boolean }>('admin-seed-demo', {});
      setRes(r);
      toast.success('Cuentas demo listas.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron crear las cuentas demo.');
    } finally {
      setCreando(false);
    }
  }

  const rolLabel: Record<string, string> = { miembro: 'Miembro', recepcionista: 'Recepción', admin: 'Admin' };

  return (
    <section className="ek-card" style={{ marginBottom: '28px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>CUENTAS DEMO</p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Una cuenta por rol para que pruebes la app como cada uno (auth y datos reales, no un preview).
        Ábrelas en una <strong>ventana privada u otro navegador</strong> para no cerrar tu sesión de admin.
        El miembro demo ya tiene plan y ficha lista para probar reservas y check-in.
      </p>
      <button type="button" onClick={crear} disabled={creando} className="ek-cta ek-cta--secondary" style={{ width: 'auto' }}>
        {creando ? <Spinner size={16} /> : res ? 'Regenerar cuentas demo' : 'Crear cuentas demo'}
      </button>

      {res && (
        <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '13px', color: 'var(--ek-ink)' }}>
            Contraseña (todas): <code style={{ fontFamily: 'var(--ek-font-mono)', color: 'var(--ek-mustard)' }}>{res.password}</code>
          </div>
          {res.cuentas.map((c) => (
            <div key={c.email} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', padding: '8px 12px', background: 'var(--ek-bg-soft)', border: '0.5px solid var(--ek-line)', borderRadius: 'var(--ek-r-sm)' }}>
              <span style={{ fontWeight: 700, color: 'var(--ek-mustard)', minWidth: '78px' }}>{rolLabel[c.rol] ?? c.rol}</span>
              <span style={{ fontFamily: 'var(--ek-font-mono)', color: 'var(--ek-ink)' }}>{c.email}</span>
            </div>
          ))}
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: '4px 0 0' }}>
            Entra en <strong>/login</strong> con cada correo + la contraseña. Bórralas o cámbiales la contraseña antes de abrir al público.
          </p>
        </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ marginBottom: '12px', fontSize: '11px' }}
      >
        {title}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>{children}</div>
    </section>
  );
}

function PersonaCard({
  usuario: u,
  currentUserId,
  onCambiarRol,
  onRevoke,
  onHardDelete,
  onResetPassword
}: {
  usuario: Usuario;
  currentUserId: string | undefined;
  onCambiarRol: () => void;
  onRevoke: () => void;
  onHardDelete: () => void;
  onResetPassword: () => void;
}) {
  const esYo = u.id === currentUserId;
  const nombre = capitalizar(u.nombre) || u.email;

  return (
    <div
      className="adm-card"
      style={{
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '17px',
            fontWeight: 600,
            margin: 0,
            marginBottom: '2px',
            color: 'var(--ek-ink)',
            letterSpacing: '-0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {nombre}
          {esYo && (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: 'var(--ek-mustard)',
                marginLeft: '8px'
              }}
            >
              (TÚ)
            </span>
          )}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '2px' }}>
          {u.email}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: 0 }}>
          {rolLabel(u.rol)}
          {u.status !== 'activo' && ` · status: ${u.status}`}
        </p>
      </div>
      <CardMenuDropdown
        items={[
          { label: 'Cambiar rol', icon: RefreshCw, onClick: onCambiarRol },
          // Un recepcionista que olvida su clave ya no depende del correo de recuperación.
          { label: 'Resetear contraseña', icon: KeyRound, onClick: onResetPassword },
          { label: 'Revocar acceso', icon: Ban, onClick: onRevoke, danger: true, divider: true },
          { label: 'Eliminar definitivamente', icon: Trash2, onClick: onHardDelete, danger: true }
        ]}
      />
    </div>
  );
}

