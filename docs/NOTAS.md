# Notas del proyecto (decisiones y pendientes)

Este archivo junta las decisiones de negocio y los pendientes para que no se pierdan.
Detalle técnico de planes: [`billing.md`](billing.md).

Flujo de trabajo: todo directo a `main`, sin pull requests (por ahora).

---

## 1. Planes y límites (hecho, precios provisionales)

| Plan     | Precio        | Negocios | Sucursales | Clientes | Reservas / mes |
|----------|---------------|----------|------------|----------|----------------|
| Gratis   | $0            | 1        | 1          | 5        | sin límite     |
| Estándar | $399 / mes    | 1        | 1          | sin límite | 500          |
| Premium  | Próximamente  | –        | –          | sin límite | sin límite   |

Extras (Estándar en adelante):
- Sucursal extra: **$199 / mes**
- Negocio extra: **$299 / mes**

- Precios y límites se cambian en un solo lugar: `packages/shared` (`PLAN_LIMITS`, `ADDON_PRICES`).
- Al pasarse de un límite la API responde **402** (`plan_limit_*`) y la app muestra un mensaje.
- Los usuarios (admins, gerentes, colaboradores) no cuestan.
- Negocios demo: Premium (para que su historial no choque con límites).

**Pendiente:** definir Premium (precio y qué incluye) y confirmar precios finales.

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
- **Iniciar sesión con Google** (recomendado; mejor con dominio propio). Requiere crear un cliente
  OAuth gratis en Google Cloud. SSO empresarial (Okta/Entra) no por ahora.
- **Correos del sistema:** cuenta en Resend, verificar el dominio y poner `RESEND_API_KEY` y
  `EMAIL_FROM` en Vercel. Sin eso, "¿Olvidaste tu contraseña?" no envía el correo. Poner también `APP_URL`.
- Dominio propio.
- Definir Premium.
- ~~Conectar GitHub ↔ Vercel~~ (hecho: cada push a `main` se publica solo).

---

## 7. Seguridad de acceso (hecho)
- Contraseñas con hash bcrypt (no se pueden leer, solo comparar).
- Recuperar contraseña por correo: enlace de un solo uso, vence en 1 hora; al cambiarla se cierran
  todas las sesiones. Las cuentas demo (@agenda.mx) no se pueden recuperar.
- Límite de intentos de inicio de sesión: 5 por persona+dispositivo, 30 por IP y 100 por correo
  cada 15 min; 3 correos de recuperación por hora.

