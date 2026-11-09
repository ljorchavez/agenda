import type { PlanId } from '@agenda/shared';

/**
 * Subscription billing (card charged every month, paid to the platform's own account).
 * The rest of the app only talks to this interface; a provider (Stripe or Mercado Pago) plugs in
 * here when its keys are set. See docs/billing.md.
 */
export interface BillingProvider {
  name: 'stripe' | 'mercadopago';
  /** Page where the owner enters the card for `plan` (+ extra locations); the webhook confirms it. */
  checkoutUrl(opts: { tenantId: string; plan: PlanId; extraLocations: number; extraBusiness: boolean; email: string; returnUrl: string }): Promise<string>;
  /** Page where the owner changes card, sees receipts or cancels. */
  portalUrl(opts: { tenantId: string; returnUrl: string }): Promise<string>;
}

/** The configured provider, or null while card billing isn't connected yet. */
export function billingProvider(): BillingProvider | null {
  // Not connected yet: plan changes apply right away without a charge.
  return null;
}
