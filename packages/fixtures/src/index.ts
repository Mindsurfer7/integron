/** Entirely fictional organizations and prices. No external IO. */
export interface DemoOrganization {
  id: string;
  name: string;
  priceThb: number;
  turnaroundHours: number;
  available: boolean;
  channel: 'telegram' | 'whatsapp' | 'line';
}

export const demoOrganizations: readonly DemoOrganization[] = [
  { id: 'mock-alpha', name: 'Демо-клиника «Альфа»', priceThb: 950, turnaroundHours: 48, available: true, channel: 'line' },
  { id: 'mock-beta', name: 'Демо-клиника «Бета»', priceThb: 1200, turnaroundHours: 12, available: true, channel: 'whatsapp' },
  { id: 'mock-gamma', name: 'Демо-клиника «Гамма»', priceThb: 1100, turnaroundHours: 24, available: true, channel: 'telegram' }
];
