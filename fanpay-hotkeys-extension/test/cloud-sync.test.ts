import test from 'node:test';
import assert from 'node:assert/strict';

// Global mocks for Chrome extension APIs before importing service worker
const storageData: Record<string, unknown> = {};
let messageDispatcher: ((message: any, sender: any, sendResponse: (res: any) => void) => Promise<void> | void) | null = null;
let alarmListeners: Array<(alarm: { name: string }) => Promise<void>> = [];

(globalThis as any).chrome = {
  runtime: {
    getManifest: () => ({ version: '2.4.0' }),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: {
      addListener: (fn: any) => {
        messageDispatcher = fn;
      }
    },
    openOptionsPage: () => {}
  },
  alarms: {
    onAlarm: {
      addListener: (fn: any) => {
        alarmListeners.push(fn);
      }
    },
    create: () => {},
    clear: () => {}
  },
  action: {
    setBadgeBackgroundColor: () => {},
    setBadgeText: () => {}
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => {}
  },
  notifications: {
    create: () => {},
    onClicked: { addListener: () => {} }
  },
  scripting: {
    executeScript: async () => [],
    insertCSS: async () => []
  },
  storage: {
    local: {
      get: (keys: string[] | string, cb?: (res: Record<string, unknown>) => void) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const res: Record<string, unknown> = {};
        for (const k of keyArr) {
          if (k in storageData) res[k] = storageData[k];
        }
        if (typeof cb === 'function') cb(res);
        return Promise.resolve(res);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(storageData, items);
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      },
      remove: (keys: string[] | string, cb?: () => void) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) {
          delete storageData[k];
        }
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      }
    }
  }
};

// Now import service-worker to register message and alarm handlers
await import('../src/background/service-worker.ts');

// Helper to send messages through the dispatcher
function dispatch(msg: any): Promise<any> {
  assert.ok(messageDispatcher, 'Service worker message dispatcher must be registered');
  return new Promise((resolve) => {
    messageDispatcher!(msg, {}, (response: any) => {
      resolve(response);
    });
  });
}

// Reset storage and setup test session
function resetTestEnvironment(customSession?: any, customSettings?: any) {
  for (const k of Object.keys(storageData)) {
    delete storageData[k];
  }

  storageData['fphk_auth_session'] = customSession !== undefined ? customSession : {
    accessToken: 'valid-test-access-token',
    refreshToken: 'valid-test-refresh-token',
    expiresAt: Date.now() + 3600 * 1000,
    userId: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
    userEmail: 'alex@example.com'
  };

  storageData['fphk_state'] = {
    settings: {
      cloudSyncEnabled: true,
      selectedSellerAccountId: '4473774',
      lastOperator: 'Алекс',
      ...customSettings
    },
    cache: {
      orders: [],
      accountInfo: {
        userId: '4473774',
        userName: 'Hopeoflove'
      }
    }
  };

  storageData['fphk_shift_state'] = {
    shiftActive: false,
    shiftStartTime: null,
    currentOperator: 'Алекс'
  };
}

// =============================================================================
// TEST SUITE: Cloud Shift Synchronization & Decoupling
// =============================================================================

test('GET_SHIFT_STATE auto-detects cloud active shift started in Web Dashboard and syncs local storage', async () => {
  resetTestEnvironment();
  const originalFetch = globalThis.fetch;

  const cloudShiftTime = new Date(Date.now() - 1800 * 1000).toISOString();
  const cloudShiftId = 'c0a80101-0000-4000-8000-000000000099';

  globalThis.fetch = async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      return new Response(
        JSON.stringify([
          {
            id: cloudShiftId,
            user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
            seller_account_id: '4473774',
            start_time: cloudShiftTime,
            status: 'active'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({ type: 'GET_SHIFT_STATE' });
    assert.equal(res.success, true);
    assert.equal(res.cloudShiftId, cloudShiftId);
    assert.equal(res.shiftState.shiftActive, true);
    assert.equal(res.shiftState.shiftStartTime, Date.parse(cloudShiftTime));

    // Verify storage was synchronized
    assert.equal(storageData['fphk_current_cloud_shift_id'], cloudShiftId);
    const localState = storageData['fphk_shift_state'] as any;
    assert.equal(localState.shiftActive, true);
    assert.equal(localState.shiftStartTime, Date.parse(cloudShiftTime));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET_SHIFT_STATE resets local active state if shift was finished in Web Dashboard', async () => {
  resetTestEnvironment();
  const originalFetch = globalThis.fetch;

  // Simulate local thinking shift is active, but cloud has no active shifts
  storageData['fphk_current_cloud_shift_id'] = 'old-shift-uuid';
  storageData['fphk_shift_state'] = {
    shiftActive: true,
    shiftStartTime: Date.now() - 3600 * 1000,
    currentOperator: 'Алекс'
  };

  globalThis.fetch = async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      // Return empty array: shift completed in web
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({ type: 'GET_SHIFT_STATE' });
    assert.equal(res.success, true);
    assert.equal(res.cloudShiftId, null);
    assert.equal(res.shiftState.shiftActive, false);
    assert.equal(res.shiftState.shiftStartTime, null);

    // Verify local storage was cleanly cleared
    assert.equal(storageData['fphk_current_cloud_shift_id'], undefined);
    const localState = storageData['fphk_shift_state'] as any;
    assert.equal(localState.shiftActive, false);
    assert.equal(localState.shiftStartTime, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('START_SHIFT executes atomic cloud-first start: creates Supabase row and sets presence on_shift', async () => {
  resetTestEnvironment();
  const originalFetch = globalThis.fetch;

  let shiftCreated = false;
  let presenceSet = false;
  let presencePayload: any = null;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    // 1. Initial check for existing active shift
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Insert new shift
    if (urlStr.includes('/rest/v1/shifts') && init?.method === 'POST') {
      shiftCreated = true;
      const body = JSON.parse(init.body as string);
      assert.equal(body.seller_account_id, '4473774');
      assert.equal(body.user_id, '34a83ee3-dbc8-49c3-8982-c1ada97f094f');
      assert.equal(body.status, 'active');
      return new Response(JSON.stringify([{ ...body }]), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Upsert presence
    if (urlStr.includes('/rest/v1/operator_status') && init?.method === 'POST') {
      presenceSet = true;
      presencePayload = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({
      type: 'START_SHIFT',
      payload: { operatorName: 'Алекс', note: 'Начало смены из плагина' }
    });

    assert.equal(res.success, true);
    assert.ok(res.cloudShiftId);
    assert.equal(res.shiftState.shiftActive, true);
    assert.equal(shiftCreated, true, 'Must call POST /rest/v1/shifts');
    assert.equal(presenceSet, true, 'Must update public.operator_status');
    assert.equal(presencePayload.status, 'on_shift');
    assert.equal(presencePayload.active_shift_id, res.cloudShiftId);
    assert.equal(presencePayload.current_seller_account_id, '4473774');

    // Local storage updated
    assert.equal(storageData['fphk_current_cloud_shift_id'], res.cloudShiftId);
    assert.equal((storageData['fphk_shift_state'] as any).shiftActive, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('START_SHIFT prevents local ghost shift when Supabase rejects creation (e.g. unique constraint 23505)', async () => {
  resetTestEnvironment();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    // Initial check says no active shift found
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Creation fails with error
    if (urlStr.includes('/rest/v1/shifts') && init?.method === 'POST') {
      return new Response(JSON.stringify({ code: '23505', message: 'duplicate key violates idx_shifts_one_active_per_user' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({
      type: 'START_SHIFT',
      payload: { operatorName: 'Алекс' }
    });

    assert.equal(res.success, false);
    assert.ok(res.error?.includes('duplicate key') || res.error?.includes('idx_shifts_one_active_per_user'));

    // Crucial: local storage must NOT be set to active!
    const localState = storageData['fphk_shift_state'] as any;
    assert.equal(localState.shiftActive, false);
    assert.equal(storageData['fphk_current_cloud_shift_id'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('START_SHIFT prevents local shift when user is unauthenticated', async () => {
  resetTestEnvironment(null); // No auth session
  const res = await dispatch({
    type: 'START_SHIFT',
    payload: { operatorName: 'Алекс' }
  });

  assert.equal(res.success, false);
  assert.ok(res.error?.includes('войти в облако'));
  assert.equal((storageData['fphk_shift_state'] as any).shiftActive, false);
});

test('STOP_SHIFT finishes cloud shift, triggers recalculateShiftAttributions, and resets presence to online', async () => {
  const activeShiftId = 'c0a80101-0000-4000-8000-000000000077';
  resetTestEnvironment();
  storageData['fphk_current_cloud_shift_id'] = activeShiftId;
  storageData['fphk_shift_state'] = {
    shiftActive: true,
    shiftStartTime: Date.now() - 3600 * 1000,
    currentOperator: 'Алекс'
  };

  const originalFetch = globalThis.fetch;
  let finishCalled = false;
  let recalcCalled = false;
  let presenceReset = false;
  let presencePayload: any = null;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    // 1. Finish shift
    if (urlStr.includes('/rest/v1/shifts') && init?.method === 'PATCH') {
      finishCalled = true;
      const body = JSON.parse(init.body as string);
      assert.equal(body.status, 'completed');
      assert.ok(body.end_time);
      return new Response(JSON.stringify([{ id: activeShiftId, status: 'completed' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. RPC recalculate_shift_attributions
    if (urlStr.includes('/rest/v1/rpc/recalculate_shift_attributions')) {
      recalcCalled = true;
      const body = JSON.parse(init.body as string);
      assert.equal(body.p_shift_id, activeShiftId);
      return new Response(JSON.stringify(8), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Reset presence
    if (urlStr.includes('/rest/v1/operator_status') && init?.method === 'POST') {
      presenceReset = true;
      presencePayload = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({
      type: 'STOP_SHIFT',
      payload: { note: 'Смена завершена штатно' }
    });

    assert.equal(res.success, true);
    assert.equal(finishCalled, true, 'Must call finishShift via PATCH');
    assert.equal(recalcCalled, true, 'Must call recalculateShiftAttributions RPC');
    assert.equal(presenceReset, true, 'Must update operator_status to online');
    assert.equal(presencePayload.status, 'online');
    assert.equal(presencePayload.active_shift_id, null);
    assert.equal(presencePayload.current_seller_account_id, null);

    // Verify local storage is cleared
    assert.equal(storageData['fphk_current_cloud_shift_id'], undefined);
    assert.equal((storageData['fphk_shift_state'] as any).shiftActive, false);
    assert.equal(res.completedShift.id, activeShiftId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('STOP_SHIFT resolves cloud shift ID even if missing from local storage (started on Web, stopped in Extension)', async () => {
  const webStartedShiftId = 'c0a80101-0000-4000-8000-web-started-01';
  resetTestEnvironment();
  // Notice: storage has NO fphk_current_cloud_shift_id!
  storageData['fphk_shift_state'] = {
    shiftActive: true,
    shiftStartTime: Date.now() - 1800 * 1000,
    currentOperator: 'Алекс'
  };

  const originalFetch = globalThis.fetch;
  let resolvedFromCloud = false;
  let finishedShiftId: string | null = null;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    // Active shift query from Supabase to resolve missing ID
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      resolvedFromCloud = true;
      return new Response(
        JSON.stringify([
          {
            id: webStartedShiftId,
            user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
            seller_account_id: '4473774',
            start_time: new Date(Date.now() - 1800 * 1000).toISOString(),
            status: 'active'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/rest/v1/shifts') && init?.method === 'PATCH') {
      finishedShiftId = webStartedShiftId;
      return new Response(JSON.stringify([{ id: webStartedShiftId, status: 'completed' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr.includes('/rest/v1/rpc/recalculate_shift_attributions')) {
      return new Response(JSON.stringify(3), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (urlStr.includes('/rest/v1/operator_status')) {
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    const res = await dispatch({ type: 'STOP_SHIFT' });
    assert.equal(res.success, true);
    assert.equal(resolvedFromCloud, true, 'Should query active shift when cloudShiftId is missing locally');
    assert.equal(finishedShiftId, webStartedShiftId, 'Should finish the cloud shift resolved from Supabase');
    assert.equal(res.cloudShiftId, webStartedShiftId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CLOUD_HEARTBEAT preserves active shift started on Web without downgrading presence to online', async () => {
  resetTestEnvironment();
  // Extension local storage says shift is idle
  storageData['fphk_shift_state'] = {
    shiftActive: false,
    shiftStartTime: null,
    currentOperator: 'Алекс'
  };

  const webShiftId = 'web-active-shift-55';
  const originalFetch = globalThis.fetch;
  let presenceReported: any = null;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    // Active shift query during heartbeat
    if (urlStr.includes('/rest/v1/shifts') && urlStr.includes('status=eq.active')) {
      return new Response(
        JSON.stringify([
          {
            id: webShiftId,
            user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
            seller_account_id: '4473774',
            start_time: new Date(Date.now() - 900 * 1000).toISOString(),
            status: 'active'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/rest/v1/operator_status') && init?.method === 'POST') {
      presenceReported = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  };

  try {
    // Trigger alarm handler for CLOUD_HEARTBEAT
    assert.ok(alarmListeners.length > 0, 'Must have registered alarm listeners');
    for (const listener of alarmListeners) {
      await listener({ name: 'CLOUD_HEARTBEAT' });
    }

    assert.ok(presenceReported, 'Heartbeat must have posted presence');
    // Heartbeat must report on_shift with activeShiftId, NOT online!
    assert.equal(presenceReported.status, 'on_shift');
    assert.equal(presenceReported.active_shift_id, webShiftId);
    assert.equal(presenceReported.current_seller_account_id, '4473774');

    // Local storage was synchronized as well
    assert.equal(storageData['fphk_current_cloud_shift_id'], webShiftId);
    assert.equal((storageData['fphk_shift_state'] as any).shiftActive, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
