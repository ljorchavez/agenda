// AWS Lambda entry point invoked by EventBridge Scheduler every 15 minutes.
import { sendDueReminders } from './jobs/reminders.js';
import { loadSecrets } from './lib/secrets.js';

export const handler = async () => {
  await loadSecrets();
  const result = await sendDueReminders();
  console.log('reminders', result);
  return result;
};
