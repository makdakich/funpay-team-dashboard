import type { DbClient } from '@/lib/db';

export interface FakeResponse {
  data: unknown;
  error: unknown;
  count?: number | null;
}

export interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

export type ResponseProvider = FakeResponse | (() => FakeResponse);

export interface FakeDb {
  client: DbClient;
  calls: RecordedCall[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  functionCalls: Array<{ name: string; options?: { body?: unknown } }>;
  tableCalls(table: string): RecordedCall[];
  setTableResponse(table: string, response: ResponseProvider): void;
  setRpcResponse(response: ResponseProvider): void;
  setFunctionResponse(response: ResponseProvider): void;
  setAuthUser(user: { id: string } | null): void;
}

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'or',
  'order', 'range', 'limit', 'filter', 'match', 'contains', 'textSearch'
];

/** Заглушка Supabase-клиента: записывает вызовы и отдаёт заранее заданные ответы. */
export function createFakeDb(responses: Record<string, ResponseProvider> = {}): FakeDb {
  const tableResponses: Record<string, ResponseProvider> = { ...responses };
  const calls: RecordedCall[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const functionCalls: Array<{ name: string; options?: { body?: unknown } }> = [];
  let rpcResponse: ResponseProvider = { data: null, error: null };
  let functionResponse: ResponseProvider = { data: null, error: null };
  let authUser: { id: string } | null = { id: 'test-user-uuid' };

  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    const settle = () => {
      const raw = tableResponses[table];
      const resp = typeof raw === 'function' ? raw() : (raw ?? { data: [], error: null, count: 0 });
      return Promise.resolve({ data: resp.data, error: resp.error, count: resp.count });
    };
    builder.single = () => { calls.push({ table, method: 'single', args: [] }); return settle(); };
    builder.maybeSingle = () => { calls.push({ table, method: 'maybeSingle', args: [] }); return settle(); };
    builder.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      settle().then(onFulfilled, onRejected);
    return builder;
  };

  const client = {
    from,
    auth: {
      getUser: () => Promise.resolve({ data: { user: authUser }, error: null }),
      getSession: () => Promise.resolve({ data: { session: authUser ? { user: authUser } : null }, error: null })
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const raw = rpcResponse;
      const resp = typeof raw === 'function' ? raw() : raw;
      return Promise.resolve({ data: resp.data, error: resp.error });
    },
    functions: {
      invoke: (name: string, options?: { body?: unknown }) => {
        functionCalls.push({ name, options });
        const raw = functionResponse;
        const resp = typeof raw === 'function' ? raw() : raw;
        return Promise.resolve({ data: resp.data, error: resp.error });
      }
    }
  } as unknown as DbClient;

  return {
    client,
    calls,
    rpcCalls,
    functionCalls,
    tableCalls: (table: string) => calls.filter(call => call.table === table),
    setTableResponse: (table: string, response: ResponseProvider) => { tableResponses[table] = response; },
    setRpcResponse: (response: ResponseProvider) => { rpcResponse = response; },
    setFunctionResponse: (response: ResponseProvider) => { functionResponse = response; },
    setAuthUser: (user: { id: string } | null) => { authUser = user; }
  };
}

export function findCall(calls: readonly RecordedCall[], method: string): RecordedCall | undefined {
  return calls.find(call => call.method === method);
}
