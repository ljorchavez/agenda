# Notas del proyecto (decisiones y pendientes)

Este archivo junta las decisiones de negocio y los pendientes para que no se pierdan.
Detalle técnico de planes: [`billing.md`](billing.md).

Flujo de trabajo: todo directo a `main`, sin pull requests (por ahora).

---

## 1. Planes y límites (hecho)

Precios **+ IVA**.

| Plan       | Precio       | Agendas (personas/espacios) | Sucursales incluidas | Clientes   | Reservas / mes |
|------------|--------------|-----------------------------|----------------------|------------|----------------|
| Gratis     | $0           | sin límite                  | 1                    | 5          | sin límite     |
| Individual | $249 / mes   | 1                           | 1 (sin extras)       | sin límite | 500            |
| Estándar   | $399 / mes   | sin límite                  | 1                    | sin límite | 500            |
| Premium    | $799 / mes   | sin límite                  | 2                    | sin límite | sin límite     |

- Individual, Estándar y Premium incluyen paquetes, expediente y cuestionarios, comisiones y caja.
- Fotos del expediente: 1 GB (Individual y Estándar), 10 GB (Premium). Premium: soporte prioritario.

Extras (Estándar y Premium):
- Sucursal extra: **$199 / mes**
- Negocio extra: **$299 / mes**

- Precios y límites se cambian en un solo lugar: `packages/shared` (`PLAN_LIMITS`, `ADDON_PRICES`).
- Al pasarse de un límite la API responde **402** (`plan_limit_*`) y la app muestra un mensaje.
- Los usuarios (admins, gerentes, colaboradores) no cuestan.
- Negocios demo: Premium (para que su historial no choque con límites).

**Decidido (nov 2026):** Individual $249 y Premium $799, todo + IVA.

---

## 2. Cobro automático con tarjeta (por conectar)

Objetivo: el cliente elige su plan, mete su tarjeta y se le cobra cada mes; el dinero
llega directo a nuestra cuenta.

Estado: el código ya tiene el conector (`apps/api/src/lib/billing.ts`). Hoy no hay
proveedor, así que los cambios de plan se aplican sin cobro.

### Opciones (comisiones aproximadas, verificar antes de decidir)

**Stripe (recomendado)**
- Comisión: ~3.6% + $3 MXN + IVA por cobro, + ~0.7% por Stripe Billing (suscripciones).
- Pros: suscripciones muy completas, prorratea solo los cambios de plan, maneja extras
  (sucursales/negocios) como partidas, portal donde el cliente cambia su tarjeta o cancela,
  recibos automáticos, reintentos de cobro fallido.
- Contras: algo más caro; menos conocido por el cliente mexicano.

**Mercado Pago Suscripciones**
- Comisión: ~3.49% + $4 MXN + IVA con dinero al momento (más barato si se espera la liberación).
- Pros: muy conocido y confiable para el cliente en México.
- Contras: cambiar de plan = cancelar y crear otra suscripción (sin prorrateo), sin portal
  de cliente, más trabajo para manejar extras.

### Qué falta para conectarlo
1. Elegir proveedor y crear la cuenta a nombre del negocio (RFC, cuenta bancaria).
2. Crear los productos/precios (Estándar, sucursal extra, negocio extra).
3. Implementar el proveedor en `billing.ts` (`checkoutUrl`, `portalUrl`).
4. Webhook `/api/webhooks/billing` para activar/cambiar el plan cuando el pago se confirma.
5. Columna `tenants.plan_status` y modo "solo lectura" cuando un pago falla.
6. Guardar las llaves solo como variables de entorno en Vercel (nunca en el código).

---

## 3. Facturación (CFDI)

Se necesita un **PAC** (proveedor autorizado de certificación) con API.
- **Facturapi** (recomendado): maneja varias empresas emisoras desde una cuenta, ideal
  para multi-negocio.
- Alternativas: Facturama, SW Sapien.
- El PAC cobra por factura timbrada (paquetes).

### 3a. Facturar a nuestros clientes por el uso de la plataforma
Necesario:
- Nuestro RFC, régimen fiscal, código postal.
- Nuestro CSD (Certificado de Sello Digital: `.cer`, `.key` y contraseña), se tramita en el SAT.
- Datos fiscales de cada cliente: RFC, razón social, código postal, régimen, uso de CFDI.
- Idealmente: facturar automático cuando el cobro con tarjeta se confirma (webhook).
- Factura global al público en general para quien no pida factura.

### 3b. Módulo para que cada negocio facture a sus propios clientes (extra de pago)
- **No incluido** en Gratis ni Estándar; se vende como extra (mensualidad + paquete de facturas).
- Cada negocio sube: RFC, régimen fiscal, código postal y su CSD (`.cer`, `.key`, contraseña).
  El CSD se guarda cifrado.
- Al facturar una reserva/pago se piden los datos fiscales del cliente final: RFC, razón social,
  código postal, régimen y uso de CFDI.
- Funciones: emitir, enviar PDF/XML por correo, cancelar, factura global.

**Pendiente:** decidir PAC, precio del módulo y si se cobra por factura.

---

## 4. Directorio y ciudades
- El directorio es la página principal; "Iniciar sesión" abre una ventana flotante.
- "Crear cuenta" empieza con la selección de plan.
- Categorías con ícono y color: Salud, Belleza, Comida, Clases, Espacios, Mascotas, Otros.
- Por ahora todos los negocios están en **Colima** y **Guadalajara**.

---

## 5. Cuentas de prueba
- Dueño demo: `demo@agenda.mx` / `demo1234`
- Gerente (solo sucursal Guadalajara de la barbería): `gerente@agenda.mx` / `demo1234`
- Los datos demo se reinician solos cada madrugada (3:00 a. m. hora de CDMX) con el cron
  `/api/cron/reset-demo`; también a mano con `pnpm db:seed`. Solo toca los negocios demo.

---

## 6. Otros pendientes
- **Iniciar sesión con Google:** ya programado (entrar y crear cuenta). Se activa al poner
  `GOOGLE_CLIENT_ID` en Vercel: crear gratis un "ID de cliente de OAuth" tipo *Aplicación web* en
  Google Cloud con el origen `https://agenda-crm-rouge.vercel.app` (y el dominio propio cuando
  exista). No necesita secreto. SSO empresarial (Okta/Entra) no por ahora.
- **Correos del sistema:** cuenta en Resend, verificar el dominio y poner `RESEND_API_KEY` y
  `EMAIL_FROM` en Vercel. Sin eso, "¿Olvidaste tu contraseña?" no envía el correo. Poner también `APP_URL`.
- Dominio propio.
- ~~Conectar GitHub ↔ Vercel~~ (hecho: cada push a `main` se publica solo).

---

## 7. Seguridad de acceso (hecho)
- Contraseñas con hash bcrypt (no se pueden leer, solo comparar).
- Recuperar contraseña por correo: enlace de un solo uso, vence en 1 hora; al cambiarla se cierran
  todas las sesiones. Las cuentas demo (@agenda.mx) no se pueden recuperar.
- Límite de intentos de inicio de sesión: 5 por persona+dispositivo, 30 por IP y 100 por correo
  cada 15 min; 3 correos de recuperación por hora.

---

## 8. Horarios, bloqueos, fotos y calificación (hecho)
- Cada persona/espacio puede tener horario propio; negocio, sucursales y personas aceptan
  descansos (horario quebrado, hasta 4).
- Bloqueos de días u horas (todo el negocio, una sucursal o un recurso) desde la agenda.
- Fotos de equipo/espacios y servicios en Vercel Blob (store `agenda-fotos`, variable `BLOB_READ_WRITE_TOKEN`).
- Nota y calificación interna 1–5 por cita; promedio por cliente.
- ~~Pendiente sugerido: que el cliente califique su visita con un enlace por WhatsApp.~~ (hecho en la sección 11)


---

## 9. Página pública personalizada (hecho)
Cada negocio ya tiene su página `/b/<slug>`. Agregar personalización sencilla, para todos los
planes, guardada en la configuración del negocio (sin migración) y editable en Configuración →
Negocio con vista previa:
- Banner arriba y logo junto al nombre (también en el directorio).
- Galería sencilla del lugar (4–8 fotos), para todos los planes.
- Redes (Instagram, Facebook, TikTok) y botón de WhatsApp.
- Aviso destacado opcional ("Cerramos el 24", "2x1 los martes").
- Vista previa al compartir la liga en WhatsApp con su banner, nombre y colonia (hecho).
- **Mismos colores de Agenda para todos** (sin color de marca ni plantillas).
- Después: dominio propio por negocio (Premium).

## 10. "Cualquiera disponible" (hecho)
Lo decide cada negocio en Configuración → Reservas:
- **Menos uso** (como era antes): reparte el trabajo.
- **El más barato libre**: el cliente paga el precio "desde" que vio.
- **Mis favoritos en orden**: el primero libre de una lista que acomoda el negocio.
Las mesas de restaurante siguen asignándose por tamaño de grupo.


---

## 11. Paquetes, expediente, comisiones/caja, reseñas y calendario (hecho, migración 0011)

**Paquetes, membresías y tarjetas de regalo** (Estándar y Premium)
- Catálogo en Configuración → Paquetes: paquete = N sesiones con vigencia en días; membresía =
  un mes con sesiones ilimitadas o con tope mensual. Cubren todos los servicios o los elegidos.
- Venta desde la ficha del cliente (pago en efectivo, tarjeta o transferencia; en línea, después).
  La membresía se renueva vendiendo otro mes.
- Consumo: al marcar "Asistió", la ventana de la cita ofrece "Descontar sesión" de un paquete
  vigente que cubra ese servicio, o "Cobrar normal". La cita queda cubierta (no debe). Si se
  deshace "Asistió", la sesión regresa al paquete. Una clase con 2 lugares toma 2 sesiones.
- Tarjeta de regalo: código de 8 caracteres, se vende al cliente que la compra (puede ser para
  otra persona) y se usa como forma de pago al cobrar una cita (descuenta saldo).
- El cliente ve "te quedan N sesiones" al reservar y en "gestionar mi cita".

**Expediente del cliente** (Estándar y Premium)
- Alergias, padecimientos/medicamentos, notas con fecha y autor (historial), fotos antes/después
  con nota, y casilla de consentimiento (fecha y quién lo registró).
- Cifrado en la base de datos (AES-256-GCM, `lib/crypto.ts`). Lo ven dueño, administradores y el
  colaborador que atendió al cliente; recepción no.
- Fotos en un store de Vercel Blob **privado** (`agenda-expedientes`, ya creado). Solo se sirven
  a través de la API con sesión; nunca en páginas públicas. Comprimidas en el navegador (máx. 5 MB),
  tope de 1 GB (Estándar) y 10 GB (Premium). Al borrar al cliente se borran sus fotos.
- **Pendiente tuyo:** conectar el store al proyecto con el prefijo `EXPEDIENTES` (crea la variable
  `EXPEDIENTES_READ_WRITE_TOKEN`). Mientras tanto el expediente funciona sin fotos.
- Recomendado: crear `DATA_ENCRYPTION_KEY` **antes** de tener datos reales (hoy la llave sale de
  `JWT_SECRET`; cambiarla después vuelve ilegibles los datos cifrados existentes).

**Comisiones y corte de caja** (Estándar y Premium)
- Porcentaje general por persona y, opcional, por servicio (Cobros → Comisiones → Porcentajes).
- Reporte por rango de fechas con citas completadas, vendido y comisión; exporta CSV (Excel).
  Las sesiones de paquete cuentan a precio completo; con cupón o recompensa, al precio cobrado.
- Corte de caja por día y sucursal: cobros por forma de pago (incluye tarjeta de regalo) y ventas
  de paquetes/membresías/tarjetas; efectivo esperado contra contado, diferencia, quién lo hizo e
  historial. Gerente: solo su sucursal. Colaborador: solo sus comisiones, sin caja.

**Reseñas verificadas** (todos los planes)
- Enlace único por cita completada (`/r/<token>`, mismo token firmado de "gestionar mi cita");
  1–5 estrellas y comentario, una por cita. Se publica con nombre e inicial del apellido.
- El negocio responde en público u oculta reseñas; no puede editarlas.
- Promedio, número y las más recientes en la página pública y en el directorio.
- Botón "Pedir reseña por WhatsApp" en la cita completada (enlace wa.me). El envío automático
  por WhatsApp después de la visita queda pendiente (hoy solo hay recordatorios).

**Calendario por suscripción (iCal)** (todos los planes)
- Enlace secreto del negocio, de cada sucursal y de cada persona (el colaborador solo ve el suyo),
  en Configuración → Mi cuenta. Botón copiar, instrucciones y "Regenerar" (invalida el anterior).
- Eventos con servicio, primer nombre y sucursal; sin teléfonos ni notas. 30 días atrás y 180 adelante.

---

## 11b. Cuestionarios por tipo de cita (hecho, migración 0012)

- Configuración → **Cuestionarios**: cada negocio arma formularios (texto corto/largo, sí/no, una opción, varias opciones, número, fecha; obligatoria o no). Son opcionales.
- Un cuestionario se marca en **varios tipos de cita** (se reutiliza).
- **Lo llena el negocio durante la cita** (en la ventana de la cita: "Llenar"). La reserva en línea NO pregunta nada, para que reservar siga siendo rápido.
- Las respuestas quedan en el **expediente** del cliente (cifrado, mismos permisos que el expediente) y muestran quién las llenó.
- Las respuestas guardan una copia de las preguntas: editar o borrar el cuestionario no cambia lo ya contestado.
- Va con la función de expediente (plan Estándar y Premium).
- Demo: nutrición "Historia clínica nutricional" (Consulta inicial y Plan alimenticio + bioimpedancia) y médico "Antecedentes médicos" (primera vez y medicina interna), con respuestas.
- La columna `forms.ask_online` quedó sin uso (se ignora).

## 11c. Venta en línea de paquetes y tarjetas de regalo (hecho, migración 0013)
- Configuración → Paquetes → **Vender en línea**: el cliente compra desde la página de reservas
  (sección "Paquetes y tarjetas de regalo") y paga con el **Mercado Pago del negocio**.
- Requiere tener Mercado Pago conectado y plan con paquetes. Montos de tarjeta de regalo: hasta 6.
- Al confirmarse el pago (webhook) se crea solo el paquete/membresía o la tarjeta (una sola vez).
  El cliente ve su código o su paquete en una liga privada `/compra/<token>`.
- Cuenta como venta en reportes y en el corte de caja (forma de pago Mercado Pago).
- Los negocios demo no tienen Mercado Pago, así que ahí no aparece la sección.

## 11d. Ajustes de página, reseñas, cupones y guardado (nov 2026)
- Página del negocio: foto de perfil sobre la portada; redes como botones redondos con ícono;
  primero "Elige un servicio" y las reseñas al final (como Fresha/Booksy: calificación junto al
  nombre, detalle abajo).
- Reseñas: se publican a partir de **3**; el negocio puede apagarlas (Configuración → Reseñas) y
  siguen llegando solo para él. Puede responder en público u ocultar reseñas ofensivas.
- Cupones (migración 0014): válidos para todos los servicios o solo algunos, y usos por cliente
  (por defecto 1). BIENVENIDA en las demos: 1 vez por cliente y solo primera consulta.
- Configuración se guarda sola al escribir (sin botón Guardar). En listas (cupones, paquetes,
  cuestionarios, sucursales, usuarios) el botón dice "Agregar"/"Listo".
- Mismo alto para todos los campos y tarjetas de una misma fila.

## 11e. Giros de salud: expediente clínico NOM-004 y NOM-013 (hecho, migración 0015)
- Giro por categoría (como el directorio): primero la categoría y adentro sus giros (registro,
  nuevo negocio y Configuración).
- Giros de salud (médico, dental, nutrición, psicología, fisioterapia) dicen "Pacientes".
- Expediente clínico por paciente con plantillas por giro:
  - Médico: historia clínica, nota de evolución, receta, interconsulta, referencia, consentimiento.
  - Dental (NOM-013): historia estomatológica con odontograma (FDI, permanentes y temporales),
    nota de evolución con odontograma actualizado, receta, referencia, consentimiento.
  - Psicología: historia psicológica con examen mental y nota de sesión.
  - Fisioterapia: valoración (EVA, arcos, fuerza) y nota de sesión.
  - Nutrición: historia nutricional con antropometría e IMC y seguimiento.
- Borrador que se guarda solo; firma con contraseña (fecha, hora, nombre, cédula y huella
  SHA-256). Lo firmado no cambia: se corrige con nota aclaratoria firmada.
- Contenido cifrado. Bitácora de accesos (consultar, firmar, imprimir) visible para dueño/admin.
- Conservación 5 años: un paciente con expediente firmado se archiva en lugar de borrarse
  ("Ver archivados" en la lista).
- Impresión / PDF con membrete (razón social, licencia sanitaria), datos del paciente y firma con
  cédula. Consentimiento con firmas en pantalla de paciente, profesional y 2 testigos.
- Datos profesionales (cédula, institución, especialidad) en Mi cuenta; datos del consultorio en
  Configuración. Desde la cita: botón "Nota de evolución".
- Demos nuevas (demo@): dental-demo, psicologia-demo, fisioterapia-demo, con expedientes de ejemplo
  (también en medico-demo y nutricion-demo).
- Decimos "conforme a la NOM-004", nunca "certificado". Pendiente (con costo): certificación
  NOM-024 y firma electrónica avanzada (e.firma SAT).

## 12. Competencia y pendientes

### Competencia real en México
- **AgendaPro** (Chile): más de 20 mil negocios en México; levantó US$35 millones en 2025.
  Planes MX$299 (1 profesional), $550 (2–20) y $1,500 Premium, + IVA. WhatsApp en paquetes desde
  $100 por 50 mensajes; facturación "próximamente".
- **Reservio** (República Checa): básico, de US$10 a 40 por usuario.
- **Reservo** (Chile): enfocado en salud y expediente clínico.
- **Fresha y Booksy**: marketplaces que cobran comisión por cliente nuevo (se reporta 15–20%).

### Nuestras ventajas
- Un sistema para cualquier giro: citas, mesas, canchas y clases.
- Directorio sin comisión.
- Precio por negocio, no por profesional.
- Plan gratis, varias sucursales con gerentes y soporte local en Colima y Guadalajara.

### Pendientes (en orden)
1. ~~App instalable desde el navegador (PWA) e íconos~~ (hecho: aviso "Instala Agenda" en el
   celular, atajos "Nueva cita" y "Clientes", página sin conexión).
2. Cobros: suscripción con tarjeta (falta proveedor). El anticipo al reservar y la venta en línea
   de paquetes y tarjetas de regalo ya están hechos.
3. Facturación CFDI: AgendaPro aún no la tiene; es nuestra mejor ventaja.
4. Confianza: testimonios de negocios reales, dominio propio y soporte por WhatsApp.
5. Sincronización completa con Google Calendar en los dos sentidos (OAuth):
   - Que los eventos personales bloqueen horarios.
   - Requiere un proyecto de Google Cloud a tu nombre y la verificación de Google (semanas).
   - Hoy solo existe el enlace de suscripción (un sentido).

### Estrategia de precios
- No bajar precios.
- Agregar un plan **Individual** de unos $249 + IVA (1 profesional).
- Incluir un paquete de WhatsApp en Estándar.
- Publicar los precios "+ IVA".
- Vender contra las comisiones de Fresha y Booksy.
- Entrar por los nichos débiles de la competencia: pádel, restaurantes, clases y gimnasios en
  GDL; todos los giros en Colima, con visitas en persona.

### Nombre de la marca
- Finalistas con .com libre: **Cupolio.com, Turnoma.com, Apartadito.com, Cupoclub.com y
  Turnoamigo.com**.
- Falta revisar el IMPI (Marcanet, clases 42 y 35) antes de comprar el dominio y registrar la marca.
- Evitar nombres con "Agend-" y "Reserv-": se parecen a AgendaPro, Agendio, Reservio y Reservo.

### Tamaño ideal
- 300–600 negocios pagando para operarlo con 1–2 personas de soporte.
- WhatsApp es el costo más grande por cliente: incluirlo con tope, no ilimitado.
