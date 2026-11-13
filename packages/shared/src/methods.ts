/** Ways to take money in person, as offered on screen (card split into credit and debit for the SAT). */
export const IN_PERSON_METHODS = ['cash', 'credit_card', 'debit_card', 'transfer'] as const;
export type InPersonMethod = (typeof IN_PERSON_METHODS)[number];
/** Also accepted from older screens and queued offline sales: plain "card" (before credit/debit). */
export const IN_PERSON_ACCEPTED = ['cash', 'card', 'credit_card', 'debit_card', 'transfer'] as const;

/** In-person methods this business takes (the "Tarjeta" switch covers credit and debit). */
export function inPersonMethods(pay: { methods: { cash: boolean; card: boolean; transfer: boolean } }): InPersonMethod[] {
  const on = IN_PERSON_METHODS.filter((m) => pay.methods[m === 'credit_card' || m === 'debit_card' ? 'card' : m]);
  return on.length ? on : [...IN_PERSON_METHODS];
}
