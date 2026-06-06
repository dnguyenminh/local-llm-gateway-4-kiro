/**
 * Auth Types — shared type definitions for authentication.
 */

export interface KiroSSOToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  region?: string;
  authRegion?: string;
  authMethod?: string;
  apiRegion?: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  clientIdHash?: string;
  provider?: string;
  startUrl?: string;
}

export interface KiroAuthResult {
  mode: 'kiro';
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: Date;
  };
  region: string;
  apiRegion: string;
  bearerToken: string;
  refreshToken?: string;
  profileArn?: string;
}

export interface ApiKeyAuthResult {
  mode: 'api_key';
  apiKey: string;
}

export type AuthResult = KiroAuthResult | ApiKeyAuthResult;

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  profileArn?: string;
  expiresAt: string;
}
