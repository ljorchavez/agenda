/** Deploy step: creates the WhatsApp templates this app uses if they're missing. Never fails the build. */
import { ensureWhatsAppTemplates } from './whatsapp.js';

ensureWhatsAppTemplates()
  .then((r) => console.log(`[whatsapp] ${r}`))
  .catch((e) => console.error('[whatsapp] templates skipped:', e));
