import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '../components/Layout';

/** Who runs Lugali (shown in the legal pages and the footer). */
export const OWNER = {
  brand: 'Lugali',
  name: 'Luis Jorge Chávez Cernas',
  address: 'Calle Francisco L. Urquizo 66, Col. Santa Cristina, C.P. 28973, Villa de Álvarez, Colima, México',
  email: 'contacto@lugali.com',
  updated: '11 de noviembre de 2026',
};

/** Small footer with the legal links, for the public pages. */
export function LegalFooter({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <footer className={`px-4 py-6 text-center text-xs text-slate-500 ${className}`} data-testid="legal-footer">
      <p>
        © 2026 {OWNER.brand} ·{' '}
        <Link to="/privacidad" className="hover:underline">{t('legal.privacy')}</Link> ·{' '}
        <Link to="/terminos" className="hover:underline">{t('legal.terms')}</Link> ·{' '}
        <a href={`mailto:${OWNER.email}`} className="hover:underline">{OWNER.email}</a>
      </p>
    </footer>
  );
}

/** "By creating an account you accept…" line for the sign-up form. */
export function AcceptLegal() {
  const { t } = useTranslation();
  return (
    <p className="text-center text-xs text-slate-500" data-testid="accept-legal">
      {t('legal.acceptPrefix')}{' '}
      <Link to="/terminos" target="_blank" className="text-brand-700 hover:underline">{t('legal.terms')}</Link>{' '}
      {t('legal.and')}{' '}
      <Link to="/privacidad" target="_blank" className="text-brand-700 hover:underline">{t('legal.privacy')}</Link>.
    </p>
  );
}

function LegalPage({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="font-bold text-brand-700">{OWNER.brand}</Link>
          <LanguageSwitch />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <article className="card space-y-4 text-sm leading-relaxed text-slate-700 [&_h2]:pt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1" data-testid={testId}>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          <p className="text-xs text-slate-500">{t('legal.updated')}: {OWNER.updated}</p>
          {children}
        </article>
      </main>
      <LegalFooter />
    </div>
  );
}

const Mail = () => <a href={`mailto:${OWNER.email}`} className="text-brand-700 hover:underline">{OWNER.email}</a>;

export function PrivacyPage() {
  return (
    <LegalPage title="Aviso de privacidad" testId="privacy-page">
      <h2>1. Quién es el responsable</h2>
      <p>
        {OWNER.name}, persona física que opera la plataforma <strong>{OWNER.brand}</strong> (lugali.com), con domicilio en {OWNER.address}, es responsable del
        tratamiento de los datos personales que se describen en este aviso, conforme a la Ley Federal de Protección de Datos Personales en Posesión de los
        Particulares. Para cualquier asunto de privacidad escribe a <Mail />.
      </p>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li><strong>De los negocios y su equipo:</strong> nombre, correo, teléfono, contraseña (guardada cifrada), datos del negocio (nombre, giro, dirección, horarios, servicios y precios), datos bancarios para recibir pagos y, si facturan, datos fiscales (RFC, razón social, régimen y código postal).</li>
        <li><strong>De los clientes y pacientes de los negocios:</strong> nombre, teléfono, correo, citas, pagos, compras, reseñas y, en negocios de salud, el expediente clínico que captura el profesional (historia clínica, notas, diagnósticos, recetas y estudios), que incluye datos personales sensibles.</li>
        <li><strong>De quien visita el sitio:</strong> datos técnicos básicos (dirección IP, navegador y páginas visitadas) para operar y proteger el servicio.</li>
      </ul>
      <p>No guardamos números de tarjeta: los pagos en línea los procesa Mercado Pago.</p>

      <h2>3. Para qué los usamos</h2>
      <p>Finalidades necesarias para dar el servicio:</p>
      <ul>
        <li>Crear y administrar cuentas, iniciar sesión y mantener la seguridad.</li>
        <li>Agendar, cambiar y cancelar citas y reservaciones.</li>
        <li>Enviar confirmaciones, recordatorios y avisos de citas por correo y por WhatsApp.</li>
        <li>Cobrar, registrar pagos y emitir facturas (CFDI) cuando el negocio lo solicita.</li>
        <li>Llevar el expediente clínico en negocios de salud y dar acceso al paciente a su portal.</li>
        <li>Atender dudas, aclaraciones y soporte, y cumplir obligaciones legales.</li>
      </ul>
      <p>
        Finalidad adicional: enviar a los negocios novedades y consejos sobre {OWNER.brand}. Si no quieres recibirlas, escribe a <Mail />; negarte no afecta el
        servicio.
      </p>

      <h2>4. Datos de clientes y pacientes de cada negocio</h2>
      <p>
        Cada negocio decide qué datos de sus clientes o pacientes registra y para qué; respecto de esos datos, el negocio es el responsable y {OWNER.brand}{' '}
        los trata solo por su cuenta, como encargado, para prestarle el servicio. El negocio debe informar a sus clientes con su propio aviso de privacidad y,
        en el caso de datos de salud, obtener su consentimiento expreso. Si eres cliente o paciente de un negocio, dirige tus solicitudes primero a ese
        negocio; también puedes escribirnos y la canalizaremos.
      </p>

      <h2>5. Con quién compartimos datos</h2>
      <p>Usamos proveedores que tratan los datos por nuestra cuenta y solo para dar el servicio:</p>
      <ul>
        <li>Vercel y Neon: alojamiento de la aplicación y base de datos.</li>
        <li>Resend: envío de correos.</li>
        <li>Meta (WhatsApp Business): envío de mensajes de WhatsApp.</li>
        <li>Mercado Pago: procesamiento de pagos.</li>
        <li>Facturapi: timbrado de facturas electrónicas.</li>
        <li>Google: inicio de sesión con cuenta de Google, si eliges usarlo.</li>
      </ul>
      <p>
        Algunos de estos proveedores guardan información fuera de México. No vendemos datos personales. Solo los compartiríamos con autoridades cuando una
        ley o una orden competente lo exija.
      </p>

      <h2>6. Tus derechos (ARCO) y cómo ejercerlos</h2>
      <p>
        Puedes acceder a tus datos, rectificarlos, cancelarlos u oponerte a su uso, así como revocar tu consentimiento o limitar su uso, escribiendo a <Mail />{' '}
        con tu nombre, un medio para responderte, una identificación y la descripción de lo que pides. Te responderemos en un máximo de 20 días hábiles. Ten
        en cuenta que el expediente clínico debe conservarse al menos 5 años (NOM-004-SSA3-2012), por lo que algunos datos no pueden borrarse antes.
      </p>

      <h2>7. Seguridad</h2>
      <p>
        Usamos conexiones cifradas, contraseñas cifradas, accesos por rol, archivos privados para estudios clínicos y registro de accesos al expediente.
        Ningún sistema es infalible; si ocurriera una vulneración que te afecte, te lo informaremos.
      </p>

      <h2>8. Cookies y almacenamiento</h2>
      <p>
        Guardamos en tu navegador tu sesión y tu idioma para que la aplicación funcione. No usamos cookies de publicidad. El botón de Google y el mapa cargan
        recursos de esos proveedores, sujetos a sus propias políticas.
      </p>

      <h2>9. Cambios a este aviso</h2>
      <p>Publicaremos cualquier cambio en lugali.com/privacidad, con su fecha de actualización.</p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Términos y condiciones de uso" testId="terms-page">
      <h2>1. Quiénes somos</h2>
      <p>
        {OWNER.brand} (lugali.com) es una plataforma para que negocios en México agenden citas y reservaciones, cobren, envíen recordatorios y, en el caso de
        profesionales de la salud, lleven expedientes clínicos. La opera {OWNER.name}, con domicilio en {OWNER.address}. Contacto: <Mail />.
      </p>

      <h2>2. Aceptación</h2>
      <p>Al crear una cuenta o usar el servicio aceptas estos términos y el <Link to="/privacidad" className="text-brand-700 hover:underline">aviso de privacidad</Link>. Si no estás de acuerdo, no uses el servicio.</p>

      <h2>3. Cuentas</h2>
      <ul>
        <li>Debes ser mayor de edad y dar información verdadera.</li>
        <li>Eres responsable de tu contraseña y de lo que hagan los usuarios que invites a tu negocio.</li>
        <li>Avísanos de inmediato si sospechas de un acceso no autorizado.</li>
      </ul>

      <h2>4. Uso permitido</h2>
      <ul>
        <li>Usa el servicio solo para actividades lícitas de tu negocio.</li>
        <li>Envía mensajes (correo o WhatsApp) solo a clientes que te dieron sus datos y aceptaron recibirlos, y solo sobre sus citas, compras o servicios. Debes respetar las políticas de WhatsApp Business.</li>
        <li>No intentes vulnerar, saturar ni copiar la plataforma, ni usarla para enviar spam o contenido ilegal.</li>
      </ul>

      <h2>5. Datos de tus clientes y pacientes</h2>
      <p>
        Tú eres responsable de los datos de tus clientes y pacientes que registres: de tener su consentimiento, de informarles con tu propio aviso de
        privacidad y, si eres profesional de la salud, de cumplir la NOM-004-SSA3-2012 y demás normas aplicables. {OWNER.brand} los trata por tu cuenta para
        darte el servicio y no los usa para otros fines.
      </p>

      <h2>6. Planes, pagos y facturación</h2>
      <ul>
        <li>Los precios de los planes se muestran en la aplicación. Te avisaremos con anticipación de cualquier cambio de precio.</li>
        <li>Los cobros que hagas a tus clientes con Mercado Pago u otros medios se rigen también por los términos de esos proveedores. Tú eres responsable de los servicios que vendes, de tus políticas de cancelación y de los reembolsos a tus clientes.</li>
        <li>Si usas la facturación electrónica, eres responsable de la veracidad de tus datos fiscales y de los de tus clientes.</li>
      </ul>

      <h2>7. Disponibilidad</h2>
      <p>
        Hacemos lo razonable para que el servicio funcione de forma continua y segura, pero puede haber interrupciones por mantenimiento o causas ajenas. Los
        envíos por correo y WhatsApp dependen de terceros y no garantizamos su entrega.
      </p>

      <h2>8. Responsabilidad</h2>
      <p>
        En la medida que la ley lo permita, {OWNER.brand} no responde por daños indirectos, pérdida de ganancias o de clientes derivados del uso o la
        imposibilidad de uso del servicio, ni por decisiones médicas o comerciales tomadas con la información registrada. Nada en estos términos limita los
        derechos que te da la Ley Federal de Protección al Consumidor.
      </p>

      <h2>9. Propiedad intelectual</h2>
      <p>La plataforma, su código, marca y diseño pertenecen a {OWNER.brand}. La información que tú capturas es tuya.</p>

      <h2>10. Cancelación</h2>
      <p>
        Puedes dejar de usar el servicio cuando quieras y pedirnos una copia de tu información. Podemos suspender cuentas que incumplan estos términos.
        Conservaremos los datos que la ley obligue a guardar, como el expediente clínico.
      </p>

      <h2>11. Cambios y ley aplicable</h2>
      <p>
        Podemos actualizar estos términos; publicaremos la nueva versión en lugali.com/terminos. Se rigen por las leyes de México y, para cualquier
        controversia, las partes se someten a los tribunales competentes de Colima, Colima, salvo lo que disponga la ley a favor del consumidor.
      </p>
    </LegalPage>
  );
}
