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

export interface FakeDb {
  client: DbClient;
  calls: RecordedCall[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  tableCalls(table: string): RecordedCall[];
  setRpcResponse(response: FakeResponse): void;
}

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'or',
  'order', 'range', 'limit', 'filter', 'match', 'contains', 'textSearch'
];

/** Заглушка Supabase-клиента: записывает вызовы и отдаёт заранее заданные ответы. */
export function createFakeDb(responses: Record<string, FakeResponse> = {}): FakeDb {
  const calls: RecordedCall[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let rpcResponse: FakeResponse = { data: null, error: null };

  const from = (table: string) => {
    const response = responses[table] ?? { data: [], error: null, count: 0 };
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    const settle = () => Promise.resolve({ data: response.data, error: response.error, count: response.count });
    builder.single = () => { calls.push({ table, method: 'single', args: [] }); return settle(); };
    builder.maybeSingle = () => { calls.push({ table, method: 'maybeSingle', args: [] }); return settle(); };
    builder.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      settle().then(onFulfilled, onRejected);
    return builder;
  };

  const client = {
    from,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: rpcResponse.data, error: rpcResponse.error });
    }
  } as unknown as DbClient;

  return {
    client,
    calls,
    rpcCalls,
    tableCalls: (table: string) => calls.filter(call => call.table === table),
    setRpcResponse: (response: FakeResponse) => { rpcResponse = response; }
  };
}

export function findCall(calls: readonly RecordedCall[], method: string): RecordedCall | undefined {
  return calls.find(call => call.method === method);
}
