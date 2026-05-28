import { createSign } from 'node:crypto';

// Общая JWT-логика используется ботом и gateway: бот подписывает асимметричный
// токен, а gateway проверяет его публичным ключом и отдельно выпускает web-токены.
const devBotPrivateKeyBase64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2Z0lCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktnd2dnU2tBZ0VBQW9JQkFRQ29ZTXdEempYVEtsa2sKYkM2b1Nwdjd4MGFPL2N3TE1jcGF3V0NBTjVEdDBmV1QwWVpFaVcycTFmMnhwYWIySEkxL3hXMXJySjNzZklpawp0Y25WLzA2RUV6cE5ldUdUQU5lYlJ5aEZuZmQrYlJ4Qkt2K0pkUTVkdmN4ZGIyWEtZcHhia21hZlIvM0F1ZFpLCmZBcHFaT0Z0ZU1sL3hwemVKY0VKVXdUdEtSVlp4aGNwZ1ZPS2ZNdFJqWkdlMFpuaHFCRFNSdERyNVRWbldVbXEKaGNHeGplb2JtdDZrazRucDRzS2tiNTcyS0pGQkpxeEtNbkYvUlhxdk5aRkNkcVV4bGxwSldOT2huVGlGem83OApISytockFKcWtIVFdMalhaT2lzUkduT0llZkpLTVNUWWhBWER3aUNOM1p3dVNKRjBubTZvMDBHcUlhTjM2VHdyCkordEJaV2ozQWdNQkFBRUNnZ0VBU0U4ZGZpcmgrWmZ2cFZFaUxscXdKdzI2c3ZDeVhrSlpMT1ZyM0ZSQWxLazgKcGVqdW1PTk42Zll4RjBmVTdrOXZ3dVhWcWs1OG1aRVhtMmlJVDdMdkZKQXZVeFBJNkxrTlhwMU40YXZIbkE4ZQplYXdPQm9sekRIWFVYSEhaREhPUncwK1phNkRlakJRaXYyVUtrZ3RWdGc0UHRxUmtQSkNKR0VpRFRwZjhsOHJqCjQ3K05DNlZNbWZ0WWFIUEhPZjkySEpxTTlYYW1Kc1hHTW8xWGl3MHQyaGhaOVI5eFFOaFgvaEg2VkJXT0RDYkcKaFMrd3RUYlJZQkdxU3NVQVBaS01CSDBKRHYwYk5JRmE4QllhakdPL3F6YjJoOGFSV2tHK0E4Y2lnWlUxb2dSRwpxRmZKTFhmT01NalJNNVJNT1lDN2luL0J6NTNreUYydFVDK3lDTWhNTVFLQmdRRGUrQUNTakpLVWJrU29PUFpTCmYrWDJDM0xwTGwzVWVrNXpIcUx0eUJzRjN4OUxkRFVCUENjOW04bG1VcHYrR3A4UXE2QXV5d01aam53aU5qL04KUTkyQTNxcjVWSTBjZkRyUFlwTklxRnArV3FFQStrRWZhNjVBMGFxcHQya2VjZCsreFAxbVBheEJIM09TZnJhcQpOYmtZRzdEaFNTK2c0REJrMDBuckk5Y2Fod0tCZ1FEQlVuZVN5K1N3NFRQTDZsR1ZUd0ZhSCtTN2E1MVVuOXJsCitGcS9XZi9vQ2xnY0NGM0kzSUhpaHVWMkprRUNZTWJySDJQc0lVMEhxQ21EMFo3SEllQWNhWkI3U2hkejVOTVYKZE9YalpzdE9Hd2tsZEdWQXFXN2xodDYrQnNDZUpsV2ZTTEVueStXUlJobmQxd091Yk9GeDArMzhXUFk2SEowZApmZjlIeUVtcUVRS0JnSDhqdDEvWlhIUGE5TGRmMDhWelBMT3lENUk3YURHU2xFMDhlUGRSbFdjaHRYeVhCT3B4ClhJYmE0RnJDWEVUbTlURFNUSUtpTEdCVVNTQlJBc3lQR0MwMXl4UmxUQm1rRlB6UVh0K2RjQXlBclRJYmdTcmoKZ2ZkZ0Z3cXpsUE5SUjU1R1FhQWRKcTN6dXprYm5Ca3VqUjdjRzE0N0Z6ZUszczEvVmJVSk9NemRBb0dCQUxOSwo5WVRhdnExaEgzVzJTcFdzSVRmaHJuUTMrVUZieEZ0V2UydE9YKzFuY3BJRkhGM0dURnUzK2lZYWtsNVBQUTBoCkhyNEhvSFpDZXNZN2FnT0xJbHVYZUIwditSSk9IWXFmMFBtWEEyVGI1QjZ0bFo1anhXcndLN0tYZHByMk9LQ3kKZlVMSWNvL0tNUUV5Z2NLS1RvZ1FJbjdRVHdSVU4wNzc1UDlBL1RqUkFvR0JBSkhZYkVUcGdrZ0k3NW4vZnozRQpGQVlzSEZQL0F0QTZHSkZpTzJvdzF1L3MzcVZWN2pnbzhRTFVyRUZ3aHhKSEVHWGx4VndMUkIvcHpkMnZpUVN0CjlnVFV4YUNIOGt3eCt5NzNsNGxrWlIxVG94ajJVcXdSK3VoQ1VRNWhhYVM0blBKeFhrTkpxS2NuVkJuOW8wZnAKSUQ1ekNkblZGZGNCMzFmQWloQUtjWWtkCi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0K';
const devBotPublicKeyBase64 =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFxR0RNQTg0MTB5cFpKR3d1cUVxYgorOGRHanYzTUN6SEtXc0ZnZ0RlUTdkSDFrOUdHUklsdHF0WDlzYVdtOWh5TmY4VnRhNnlkN0h5SXBMWEoxZjlPCmhCTTZUWHJoa3dEWG0wY29SWjMzZm0wY1FTci9pWFVPWGIzTVhXOWx5bUtjVzVKbW4wZjl3TG5XU253S2FtVGgKYlhqSmY4YWMzaVhCQ1ZNRTdTa1ZXY1lYS1lGVGluekxVWTJSbnRHWjRhZ1Ewa2JRNitVMVoxbEpxb1hCc1kzcQpHNXJlcEpPSjZlTENwRytlOWlpUlFTYXNTakp4ZjBWNnJ6V1JRbmFsTVpaYVNWalRvWjA0aGM2Ty9CeXZvYXdDCmFwQjAxaTQxMlRvckVScHppSG55U2pFazJJUUZ3OElnamQyY0xraVJkSjV1cU5OQnFpR2pkK2s4S3lmclFXVm8KOXdJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg==';

export type BotJwtPayload = {
  sub: string;
  user_id: number;
  client: 'bot';
  iat: number;
  exp: number;
};

export function getBotPrivateKey(): string {
  return decodeKey(nonEmpty(process.env.BOT_JWT_PRIVATE_KEY_BASE64) ?? devBotPrivateKeyBase64);
}

export function getBotPublicKey(): string {
  return decodeKey(nonEmpty(process.env.BOT_JWT_PUBLIC_KEY_BASE64) ?? devBotPublicKeyBase64);
}

export function getClientJwtSecret(): string {
  return nonEmpty(process.env.CLIENT_JWT_SECRET) ?? 'springcat-dev-client-jwt-secret-change-me';
}

export function signBotJwt(userId: number, ttlSeconds = 60): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: BotJwtPayload = {
    sub: String(userId),
    user_id: userId,
    client: 'bot',
    iat: now,
    exp: now + ttlSeconds
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(getBotPrivateKey());
  return `${signingInput}.${signature.toString('base64url')}`;
}

function decodeKey(value: string): string {
  return value.includes('BEGIN ') ? value : Buffer.from(value, 'base64').toString('utf8');
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
