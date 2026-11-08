// AWS Lambda entry point for the HTTP API (API Gateway HTTP API, payload v2).
import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { loadSecrets } from './lib/secrets.js';

const app = createApp();
const honoHandler = handle(app);

export const handler: typeof honoHandler = async (event, context) => {
  await loadSecrets();
  return honoHandler(event, context);
};
