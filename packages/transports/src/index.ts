import type { DemoOrganization } from '../../fixtures/src/index.ts';

/** Deterministic fake transport. It NEVER connects to Telegram/WhatsApp/LINE. */
export function simulateExchange(org: DemoOrganization) {
  return {
    outgoing: 'Здравствуйте! Подскажите, пожалуйста, стоимость, наличие и сроки услуги.',
    incoming: `ДЕМО: услуга доступна; ${org.priceThb} THB; срок ${org.turnaroundHours} ч.`,
    channel: org.channel,
    evidenceRef: `fixture:${org.id}`
  };
}
