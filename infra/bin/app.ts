import { App } from 'aws-cdk-lib';
import { AgendaStack } from '../lib/agenda-stack.js';

const app = new App();

/**
 * Stage = environment name. Deploy a separate staging copy with:
 *   pnpm --filter @agenda/infra deploy -c stage=staging
 */
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'prod';

new AgendaStack(app, `Agenda-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Mexico (Central) by default; override with AWS_REGION=us-east-1 if a service is missing there.
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'mx-central-1',
  },
  // Optional custom domain (requires an ACM certificate in us-east-1 for CloudFront):
  // domainName: 'app.tudominio.mx',
  // certificateArn: 'arn:aws:acm:us-east-1:...',
});
