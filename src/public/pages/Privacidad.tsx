import { useTenant } from '@shared/hooks/useTenant';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { LegalDoc } from '../components/LegalDoc';

// NOTA (David): Aviso de Privacidad base conforme a la LFPDPPP (México). NO es
// asesoría legal — revísalo con un abogado y agrega el domicilio del responsable
// si tu abogado lo requiere. Usa el nombre y el correo del tenant automáticamente.
const ACTUALIZADO = '2 de julio de 2026';

export default function Privacidad() {
  const tenant = useTenant();
  const { footer } = useLandingConfig();
  const est = tenant.nombre || 'EKKO Studio';
  const email = footer.email || 'hola@ekkostudio.app';
  const direccion = footer.direccion;

  return (
    <LegalDoc eyebrow="LEGAL" titulo="Aviso de Privacidad" actualizado={ACTUALIZADO}>
      <p>
        En cumplimiento de la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (la
        <strong> “Ley”</strong>), <strong>{est}</strong> (el <strong>“Responsable”</strong>) pone a tu disposición el
        presente Aviso de Privacidad respecto de los datos personales que recabamos de ti.
      </p>

      <h2>1. Responsable</h2>
      <p>
        <strong>{est}</strong> es responsable del tratamiento de tus datos personales. Puedes contactarnos en{' '}
        <a href={`mailto:${email}`}>{email}</a>
        {direccion ? <> o en {direccion}</> : null}.
      </p>

      <h2>2. Datos que recabamos</h2>
      <ul>
        <li><strong>Identificación:</strong> nombre, fecha de nacimiento, fotografía e identificación oficial (INE) cuando se requiere verificación para el acceso.</li>
        <li><strong>Contacto:</strong> correo electrónico y teléfono.</li>
        <li><strong>Facturación:</strong> los datos de tu tarjeta son tratados directamente por nuestro procesador de pagos (Stripe); nosotros no almacenamos el número completo de tu tarjeta.</li>
        <li><strong>Uso del servicio:</strong> historial de reservas, asistencias, membresía y comunicaciones con el Estudio.</li>
      </ul>

      <h2>3. Datos sensibles</h2>
      <p>
        Para la verificación de identidad podemos tratar tu fotografía e identificación oficial. Al proporcionarlos y
        aceptar este Aviso, otorgás tu consentimiento para su tratamiento con las finalidades aquí descritas. Estos
        datos se resguardan con acceso restringido.
      </p>

      <h2>4. Finalidades primarias</h2>
      <p>Usamos tus datos para las finalidades necesarias para prestarte el servicio:</p>
      <ul>
        <li>Crear y administrar tu cuenta y tu membresía.</li>
        <li>Gestionar reservas, accesos y asistencia.</li>
        <li>Verificar tu identidad y resguardar la seguridad de las instalaciones.</li>
        <li>Procesar cobros y emitir comprobantes.</li>
        <li>Brindarte soporte y enviarte avisos relacionados con el servicio.</li>
      </ul>

      <h2>5. Finalidades secundarias</h2>
      <p>
        De forma adicional, podríamos usar tus datos para enviarte información promocional o novedades del Estudio.
        Puedes oponerte a estas finalidades en cualquier momento escribiendo a <a href={`mailto:${email}`}>{email}</a>,
        sin que ello afecte la prestación del servicio.
      </p>

      <h2>6. Transferencias y encargados</h2>
      <p>
        No vendemos tus datos personales. Para operar, compartimos datos con proveedores que los tratan por cuenta y
        bajo instrucciones del Responsable (encargados), entre ellos:
      </p>
      <ul>
        <li><strong>Stripe</strong> — procesamiento de pagos.</li>
        <li><strong>Supabase</strong> — base de datos y autenticación.</li>
        <li><strong>Netlify</strong> — alojamiento de la aplicación.</li>
        <li><strong>Resend</strong> — envío de correos transaccionales.</li>
      </ul>
      <p>
        Estas transferencias son las necesarias para prestarte el servicio y no requieren tu consentimiento conforme a
        la Ley. Cualquier otra transferencia se realizaría previo tu consentimiento cuando la Ley lo exija.
      </p>

      <h2>7. Tus derechos ARCO</h2>
      <p>
        Tienes derecho a <strong>Acceder</strong> a tus datos, <strong>Rectificar</strong>los cuando sean inexactos,
        <strong> Cancelar</strong>los cuando consideres que no se requieren, y <strong>Oponerte</strong> a su
        tratamiento. También puedes revocar el consentimiento otorgado.
      </p>
      <p>
        Para ejercer estos derechos, envía tu solicitud a <a href={`mailto:${email}`}>{email}</a> indicando tu nombre,
        el derecho que deseás ejercer y la información suficiente para atenderte. Responderemos en los plazos que marca
        la Ley.
      </p>

      <h2>8. Conservación</h2>
      <p>
        Conservamos tus datos mientras mantengas una relación con el Estudio y, posteriormente, durante los plazos que
        exija la normativa aplicable (por ejemplo, obligaciones fiscales o de seguridad). Cumplidos esos plazos, los
        datos se eliminan o anonimizan.
      </p>

      <h2>9. Cookies y tecnologías</h2>
      <p>
        Nuestra plataforma utiliza almacenamiento local y tecnologías similares estrictamente necesarias para
        mantener tu sesión iniciada y el correcto funcionamiento de la aplicación.
      </p>

      <h2>10. Cambios al Aviso</h2>
      <p>
        Podemos actualizar este Aviso de Privacidad. Publicaremos la versión vigente con su fecha de actualización en
        esta misma página.
      </p>

      <h2>11. Contacto</h2>
      <p>
        Para cualquier duda sobre este Aviso o sobre el tratamiento de tus datos, escríbenos a{' '}
        <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </LegalDoc>
  );
}
