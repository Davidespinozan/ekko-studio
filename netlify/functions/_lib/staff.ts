/**
 * Guards de staff para las Netlify Functions.
 *
 * "Revocar acceso" solo escribe `usuarios.status='revocado'`: el rol y el login
 * quedan intactos. Como estas functions operan con service_role (saltan RLS),
 * validar solo el `rol` dejaba a un recepcionista/admin revocado —con su sesión
 * abierta o volviendo a iniciar sesión— regalando membresías, reseteando claves
 * o leyendo datos personales. El caller de TODA function de staff pasa por aquí.
 */

type ConRol = { rol?: string | null };
type ConRolYStatus = ConRol & { status?: string | null };

const ROLES_STAFF = ['admin', 'recepcionista'];

/** Admin o recepcionista con la cuenta activa. */
export function esStaffActivo<T extends ConRolYStatus>(caller: T | null | undefined): caller is T {
  return !!caller && ROLES_STAFF.includes(caller.rol ?? '') && caller.status === 'activo';
}

/** Admin con la cuenta activa. */
export function esAdminActivo<T extends ConRolYStatus>(caller: T | null | undefined): caller is T {
  return !!caller && caller.rol === 'admin' && caller.status === 'activo';
}

/**
 * Recepción solo opera sobre MIEMBROS; las cuentas del equipo las toca un admin.
 * Sin esto, un recepcionista podía cambiarle el email de acceso a un admin vía
 * API (`email_confirm: true`) y quedarse con su cuenta usando /recuperar.
 */
export function puedeOperarSobre(caller: ConRol, target: ConRol): boolean {
  return target.rol === 'miembro' || caller.rol === 'admin';
}
