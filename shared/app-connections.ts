export interface AppConnection {
  name: string; integrationId?: string; integrationName: string; title: string;
  policy: 'allow' | 'ask' | 'off' | 'unavailable'; ready: boolean; reason: string;
}
