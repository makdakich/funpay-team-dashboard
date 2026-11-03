import { FunPayAccountInfo, FunPayOrder } from '../shared/types';

export interface FunPayDiagnostics {
  status: number;
  finalUrl: string;
  contentType: string;
  hasUserElement: boolean;
  hasLoginForm: boolean;
  isCloudflare: boolean;
  details?: string;
  source?: 'content-script' | 'background-fetch';
  diagnosticReport?: string;
}

export interface FunPayAuthResult {
  authenticated: boolean;
  user: FunPayAccountInfo | null;
  error?: string;
  diagnostics?: FunPayDiagnostics;
}

export interface FunPaySyncResult {
  success: boolean;
  account: FunPayAccountInfo | null;
  orders: FunPayOrder[];
  error?: string;
  diagnostics?: FunPayDiagnostics;
}
