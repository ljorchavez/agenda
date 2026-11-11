# Agenda — CRM de citas para negocios locales

> Nombre provisional. Para renombrar: busca y reemplaza `agenda` / `Agenda` en todo el repo.

Web app multi-negocio (SaaS) para nutriólogos, médicos, cosmetólogas, barberías, etc.:
agenda, clientes con historial y métricas, página pública de reservas, recordatorios por
WhatsApp y cobros con Mercado Pago (tarjeta y SPEI).

```
apps/web        React 18 + Vite + Tailwind + TanStack Query + i18next (es/en) + Recharts
apps/api        Hono (TypeScript) + Drizzle ORM + PostgreSQL — corre local y en AWS Lambda
packages/shared Esquemas Zod y tipos compartidos por front y back
infra           AWS CDK (TypeScript): VPC, RDS, Lambda, API Gateway, CloudFront, S3, EventBridge
.github         CI (tests) y deploy a AWS
```

## Requisitos

- Node.js 20+ y pnpm (`corepack enable` lo activa)
- Docker (para PostgreSQL local)

## Correr en tu computadora

```bash
pnpm install                       # instala todo el monorepo (genera pnpm-lock.yaml: haz commit de él)
cp .env.example apps/api/.env      # variables locales; WhatsApp/Mercado Pago pueden quedar vacías
pnpm db:up                         # PostgreSQL en Docker (puerto 5432)
pnpm db:migrate                    # crea las tablas
pnpm db:seed                       # datos de ejemplo (opcional)
pnpm dev                           # API en :3000 y web en :5173
```

Abre http://localhost:5173 e inicia sesión con `demo@lugali.com` / `demo1234`
(si corriste el seed) o crea una cuenta. Página pública de reservas del demo:
http://localhost:5173/b/nutricion-demo

Sin credenciales de WhatsApp, los recordatorios se imprimen en la consola (modo `dry_run`).
Para probarlos: `pnpm --filter @agenda/api reminders:run`.

## Tests

```bash
pnpm typecheck
# Tests de integración contra una base de datos de pruebas (¡se borra completa!)
docker compose exec db createdb -U agenda agenda_test
TEST_DATABASE_URL=postgres://agenda:agenda@localhost:5432/agenda_test pnpm test
```

Incluyen una prueba de **aislamiento entre negocios**: el negocio B no puede leer ni
modificar clientes del negocio A.

## Cómo funciona el multi-negocio

Cada fila tiene `tenant_id`. El `tenantId` viene **siempre** del JWT verificado
(`middleware/auth.ts`), nunca del body ni de la URL, y cada consulta filtra por él.
Si agregas una ruta nueva, sigue el mismo patrón y agrega un caso al test de aislamiento.

## Cambios al esquema de la base

1. Edita `apps/api/src/db/schema.ts`
2. `pnpm db:generate` (crea un SQL nuevo en `apps/api/migrations`)
3. `pnpm db:migrate` local; en AWS se aplica solo en cada deploy.

## Deploy a AWS

Primera vez (desde tu computadora, con AWS CLI configurado):

```bash
pnpm --filter @agenda/web build
pnpm --filter @agenda/infra bootstrap      # una vez por cuenta/región
pnpm --filter @agenda/infra deploy
```

Al terminar, la terminal imprime `AppUrl`. Luego:

1. En **Secrets Manager**, abre el secreto `AppSecret…` y llena `WHATSAPP_*` y `MERCADOPAGO_*`
   (`JWT_SECRET` ya se generó solo).
2. Registra los webhooks que imprime el deploy (`WhatsAppWebhookUrl`, `MercadoPagoWebhookUrl`)
   en Meta for Developers y en Mercado Pago Developers.

**Deploy automático desde GitHub:** crea un rol IAM con confianza OIDC para
`token.actions.githubusercontent.com` limitado a tu repo, guárdalo como secreto
`AWS_DEPLOY_ROLE_ARN` y (opcional) la variable `AWS_REGION`. Cada merge a `main` que pase CI
se despliega solo. Para un ambiente de pruebas: Actions → Deploy → Run workflow → `staging`.

Región por defecto: `mx-central-1` (México). Si algún servicio no está disponible ahí,
usa `AWS_REGION=us-east-1`.

## WhatsApp

Crea en Meta Business Manager una plantilla **utility** llamada `appointment_reminder`
(idioma `es_MX`) con 4 variables y 2 botones de respuesta rápida:

> Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}.
> [Confirmar] [Cancelar]

Al tocar un botón, el webhook marca la cita como confirmada o cancelada.

## Mercado Pago

- **Tarjeta:** link de Checkout Pro (`POST /api/payments/link` con `method: "mercadopago"`).
- **SPEI:** orden con `bank_transfer` / `clabe` (`method: "spei"`), vigencia 3 días.
- El webhook consulta el estado real en Mercado Pago, marca el pago y confirma la cita.
- MVP: una sola cuenta de Mercado Pago (la tuya, en modo prueba). Siguiente fase: cada negocio
  conecta su propia cuenta por OAuth para recibir el dinero directo.

## Pendientes conocidos (siguientes fases)

- OAuth de Mercado Pago por negocio y número de WhatsApp por negocio
- Row Level Security en PostgreSQL como segunda barrera de aislamiento
- Recuperar contraseña por correo (Amazon SES)
- Varios profesionales por agenda en la vista de calendario
- Rate limiting más fino en reservas públicas (hoy: throttling de API Gateway)
- El panel muestra horas en la zona horaria del navegador; si un negocio opera en otra zona, mostrar todo en `tenant.timezone`
