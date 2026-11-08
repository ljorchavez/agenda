import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as apigwInt,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as targets,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secrets,
  triggers,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiSrc = (f: string) => path.join(root, 'apps/api/src', f);

export interface AgendaStackProps extends StackProps {
  stage: string;
  domainName?: string;
  certificateArn?: string;
}

/**
 * Serverless architecture:
 *   CloudFront ─┬─ S3 (React app)
 *               └─ /api/* → API Gateway (HTTP) → Lambda (Hono API) ─┐
 *   EventBridge (15 min) → Lambda (reminders) ──────────────────────┼→ RDS PostgreSQL (private)
 *   Both Lambdas reach WhatsApp / Mercado Pago through a NAT instance.
 */
export class AgendaStack extends Stack {
  constructor(scope: Construct, id: string, props: AgendaStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';

    // ---------- Network ----------
    // A t4g.nano NAT *instance* (~USD 3/mo + IP) instead of a NAT Gateway (~USD 35/mo).
    const natProvider = ec2.NatProvider.instanceV2({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
    });
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: natProvider,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    natProvider.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTraffic());

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', { vpc, description: 'Agenda Lambdas' });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Agenda PostgreSQL' });
    dbSg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Lambdas to Postgres');

    // ---------- Database ----------
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: 'agenda',
      credentials: rds.Credentials.fromGeneratedSecret('agenda'),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      multiAz: false, // turn on when revenue justifies ~2x DB cost
      backupRetention: Duration.days(7),
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });

    // ---------- App secrets ----------
    // Created empty-ish; fill real values in the AWS console (Secrets Manager) after first deploy.
    const appSecret = new secrets.Secret(this, 'AppSecret', {
      description: 'Agenda app secrets: JWT_SECRET, WHATSAPP_*, MERCADOPAGO_*',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          WHATSAPP_TOKEN: '',
          WHATSAPP_PHONE_NUMBER_ID: '',
          WHATSAPP_VERIFY_TOKEN: '',
          WHATSAPP_APP_SECRET: '',
          MERCADOPAGO_ACCESS_TOKEN: '',
          MERCADOPAGO_WEBHOOK_SECRET: '',
        }),
        generateStringKey: 'JWT_SECRET',
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    // ---------- Lambdas ----------
    const common: nodejs.NodejsFunctionProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      logRetention: logs.RetentionDays.ONE_MONTH,
      depsLockFilePath: path.join(root, 'pnpm-lock.yaml'),
      projectRoot: root,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node20',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--enable-source-maps',
        DB_SECRET_ARN: db.secret!.secretArn,
        APP_SECRET_ARN: appSecret.secretArn,
        DB_SSL: 'true',
        WHATSAPP_REMINDER_TEMPLATE: 'appointment_reminder',
        WHATSAPP_TEMPLATE_LANG: 'es_MX',
      },
    };

    const apiFn = new nodejs.NodejsFunction(this, 'ApiFn', {
      ...common,
      entry: apiSrc('lambda.ts'),
      description: 'Agenda HTTP API',
    });

    const remindersFn = new nodejs.NodejsFunction(this, 'RemindersFn', {
      ...common,
      entry: apiSrc('reminders-lambda.ts'),
      timeout: Duration.minutes(5),
      description: 'Agenda WhatsApp reminders',
    });

    const migrateFn = new nodejs.NodejsFunction(this, 'MigrateFn', {
      ...common,
      entry: apiSrc('migrate-lambda.ts'),
      timeout: Duration.minutes(5),
      description: 'Agenda DB migrations',
      bundling: {
        ...common.bundling,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/apps/api/migrations ${outputDir}/migrations`,
          ],
        },
      },
    });

    for (const fn of [apiFn, remindersFn, migrateFn]) {
      db.secret!.grantRead(fn);
      appSecret.grantRead(fn);
    }

    // Run migrations on every deploy, after the DB exists and before traffic matters.
    new triggers.Trigger(this, 'MigrateTrigger', {
      handler: migrateFn,
      executeAfter: [db],
      executeOnHandlerChange: true,
    });

    // Reminders every 15 minutes
    new events.Rule(this, 'RemindersSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(remindersFn)],
    });

    // ---------- HTTP API ----------
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: 'Agenda API',
      defaultIntegration: new apigwInt.HttpLambdaIntegration('ApiIntegration', apiFn),
    });
    // Basic abuse protection for public booking and webhooks
    const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    // ---------- Frontend ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`;
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)
      : undefined;

    // API responses are not cached (TTL 0) but Authorization must be part of the cache key
    // for CloudFront to forward it to API Gateway.
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // SPA routing on the static site only: paths without a file extension serve index.html.
    // (Distribution-wide errorResponses would also rewrite API 403/404s, so we avoid them.)
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) {
  var req = event.request;
  if (!req.uri.includes('.')) req.uri = '/index.html';
  return req;
}`,
      ),
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // Same-origin API: no CORS, no extra domain
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(root, 'apps/web/dist'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    const appUrl = props.domainName ? `https://${props.domainName}` : `https://${distribution.distributionDomainName}`;
    for (const fn of [apiFn, remindersFn]) {
      fn.addEnvironment('APP_URL', appUrl);
      fn.addEnvironment('PUBLIC_API_URL', `${appUrl}/api`);
    }

    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'AppSecretName', { value: appSecret.secretName });
    new CfnOutput(this, 'WhatsAppWebhookUrl', { value: `${appUrl}/api/webhooks/whatsapp` });
    new CfnOutput(this, 'MercadoPagoWebhookUrl', { value: `${appUrl}/api/webhooks/mercadopago` });
  }
}
