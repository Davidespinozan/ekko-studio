import { useTenant } from '@shared/hooks/useTenant';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { LegalDoc } from '../components/LegalDoc';

// NOTA (David): versión base sólida, NO es asesoría legal. Antes de producción,
// revísala con un abogado y agrega los datos fiscales del Estudio (razón social,
// RFC, domicilio) si tu abogado lo pide. El contenido usa el nombre y el correo
// del tenant automáticamente.
const ACTUALIZADO = '4 de julio de 2026';

export default function Terminos() {
  const tenant = useTenant();
  const { footer } = useLandingConfig();
  const est = tenant.nombre || 'EKKO Studio';
  const email = footer.email || 'hola@ekkostudio.app';

  return (
    <LegalDoc eyebrow="LEGAL" titulo="Términos y Condiciones" actualizado={ACTUALIZADO}>
      <p>
        Estos Términos y Condiciones (los <strong>“Términos”</strong>) regulan el uso de los servicios de{' '}
        <strong>{est}</strong> (el <strong>“Estudio”</strong>, “nosotros”), incluyendo la renta de estudios de
        creación de contenido, las membresías y la aplicación de reservas. Al crear una cuenta, contratar una
        membresía o usar nuestras instalaciones, aceptas estos Términos.
      </p>

      <h2>1. El servicio</h2>
      <p>
        El Estudio ofrece espacios equipados para producción de contenido (foto, video, podcast y usos similares),
        reservables por bloques de tiempo a través de nuestra plataforma. El acceso está sujeto a contar con una
        membresía o plan vigente y a cumplir con estos Términos. Al finalizar cada sesión te entregamos tu material
        grabado en formato MP4; algunos planes incluyen servicios adicionales (por ejemplo, edición básica y
        miniaturas) que se detallan en el plan contratado.
      </p>

      <h2>2. Tu cuenta</h2>
      <p>
        Para reservar necesitas una cuenta. Eres responsable de la veracidad de tus datos y de mantener la
        confidencialidad de tus credenciales; toda actividad realizada desde tu cuenta se considera hecha por ti.
        Debes ser mayor de edad para contratar. Avísanos de inmediato ante cualquier uso no autorizado.
      </p>

      <h2>3. Membresías, planes y créditos</h2>
      <ul>
        <li><strong>Membresía mensual:</strong> otorga acceso recurrente según el plan contratado, con cobro periódico automático.</li>
        <li><strong>Planes por créditos o paquetes:</strong> otorgan un número de sesiones que se consumen al reservar y tienen una vigencia; los créditos no usados antes de su vencimiento se pierden. Algunos estudios pueden consumir más de un crédito por sesión, según se indique en la plataforma.</li>
        <li><strong>Sin permanencia:</strong> las membresías mensuales son mes a mes; puedes cancelarlas cuando quieras, sin compromiso mínimo.</li>
      </ul>
      <p>Las características, precios y reglas de cada plan se muestran al momento de la contratación y pueden actualizarse hacia el futuro.</p>

      <h2>4. Pagos y renovación</h2>
      <p>
        Los pagos en línea se procesan a través de nuestro proveedor de pagos (Stripe); el Estudio no almacena los
        datos completos de tu tarjeta. Las membresías mensuales <strong>se renuevan automáticamente</strong> al inicio
        de cada período hasta que las canceles conforme a la sección 5. Los precios están expresados en pesos mexicanos
        (MXN) e incluyen los impuestos aplicables salvo que se indique lo contrario.
      </p>
      <p>
        Si un cobro falla, tu acceso puede mantenerse temporalmente mientras se reintenta el cobro; de no regularizarse,
        la membresía puede suspenderse. También puedes activar o regularizar tu pago en recepción.
      </p>

      <h2>5. Cancelación de la membresía</h2>
      <p>
        Puedes cancelar tu membresía cuando quieras desde tu perfil o en recepción, sin permanencia. La cancelación surte
        efecto al finalizar el período ya pagado. No se realizan reembolsos de períodos ya cobrados ni de créditos ya
        adquiridos, salvo que la ley aplicable disponga otra cosa.
      </p>

      <h2>6. Reservas, cancelaciones y no-shows</h2>
      <ul>
        <li>Las reservas se hacen por bloques dentro del horario de cada estudio; cada bloque admite <strong>una sola reserva</strong>.</li>
        <li>Puedes cancelar una sesión con la anticipación indicada en la plataforma y reservar otro horario; con menos anticipación, el cambio se acuerda con el estudio.</li>
        <li>Si no te presentas a una sesión reservada (<strong>no-show</strong>) o cancelas fuera de tiempo, la sesión se considera consumida: se descuenta el crédito correspondiente o se pierde la sesión del período, según tu plan.</li>
        <li>La acumulación de inasistencias puede derivar en la restricción temporal de nuevas reservas por un período determinado.</li>
      </ul>

      <h2>7. Verificación de identidad y acceso</h2>
      <p>
        Por seguridad y para la renta de espacios, podemos requerir la verificación de tu identidad (por ejemplo,
        identificación oficial y fotografía) antes de permitir el acceso. El ingreso puede bloquearse hasta que tu
        expediente esté completo. El tratamiento de estos datos se rige por nuestro{' '}
        <a href="/privacidad">Aviso de Privacidad</a>.
      </p>

      <h2>8. Uso del estudio y del equipo</h2>
      <p>
        Debes usar las instalaciones y el equipo de forma responsable, siguiendo las indicaciones del personal.
        Eres responsable de los daños que ocasiones al equipo o al espacio durante tu sesión, así como de la conducta
        de tus invitados. Está prohibido cualquier uso ilícito, peligroso o que afecte a otras personas o al inmueble.
      </p>

      <h2>9. Tu contenido</h2>
      <p>
        El contenido que produzcas durante tus sesiones es <strong>tuyo</strong>. El Estudio no reclama derechos de
        propiedad sobre tu material. Eres el único responsable del contenido que crees y de contar con los permisos
        necesarios de las personas que aparezcan en él.
      </p>

      <h2>10. Conducta</h2>
      <p>
        No está permitido compartir tus credenciales, suplantar a terceros, dañar la plataforma o el equipo, ni usar el
        servicio para fines ilícitos. Podemos suspender o cancelar cuentas que incumplan estos Términos.
      </p>

      <h2>11. Suspensión y terminación</h2>
      <p>
        Podemos suspender o dar de baja tu acceso ante incumplimientos, falta de pago o conductas que pongan en riesgo a
        personas, al equipo o a la operación. Tú puedes terminar tu relación con el Estudio cancelando tu membresía
        conforme a estos Términos.
      </p>

      <h2>12. Limitación de responsabilidad</h2>
      <p>
        En la medida permitida por la ley, el Estudio no será responsable por daños indirectos o pérdidas derivadas del
        uso del servicio. Nada en estos Términos limita responsabilidades que no puedan excluirse legalmente.
      </p>

      <h2>13. Cambios a los Términos</h2>
      <p>
        Podemos actualizar estos Términos. Publicaremos la versión vigente con su fecha de actualización; el uso
        continuado del servicio implica la aceptación de los cambios.
      </p>

      <h2>14. Ley aplicable</h2>
      <p>
        Estos Términos se rigen por las leyes de los Estados Unidos Mexicanos. Cualquier controversia se someterá a los
        tribunales competentes del domicilio del Estudio, renunciando a cualquier otro fuero que pudiera corresponder.
      </p>

      <h2>15. Contacto</h2>
      <p>
        Para dudas sobre estos Términos, escríbenos a <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </LegalDoc>
  );
}
