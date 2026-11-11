import { loadState, updateSettings, saveProfiles, saveTemplates, saveCache, clearApiKey, exportSettings, importSettings, loadShiftState, startShift, stopShift, loadShiftHistory, saveShift, deleteShift, recalculateShifts } from '../storage/storage';
import { upsertProfile, deleteProfile, upsertTemplate, deleteTemplate } from '../storage/profiles';
import { FunPayClient } from '../api/client';
import { DEFAULT_SUPABASE_CONFIG, SupabaseClient } from '../api/supabase';
import {
  SupabaseAuth,
  clearAuthSession,
  isSessionExpired,
  loadAuthSession,
  loadFreshSession,
  saveAuthSession
} from '../api/auth';
import { CloudAuthSession, CloudAuthState } from '../shared/types';
import { debugLog, generateUuid } from '../shared/utils';

/**
 * Cloud helpers (schema v2.4).
 *
 * Every write path in the v2.4 database derives the caller from auth.uid(), so a client
 * built here is bound to the operator JWT whenever a session exists. Without a session the
 * client still works for the anonymous-key probes, but RPC calls will be rejected by design.
 */
function getAppVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '2.4.0';
  }
}

function toAuthState(session: CloudAuthSession | null): CloudAuthState {
  if (!session) {
    return { signedIn: false };
  }
  return {
    signedIn: true,
    userId: session.userId,
    email: session.email,
    expiresAt: session.expiresAt,
    expired: isSessionExpired(session)
  };
}

/** Resolve the seller account id: explicit setting first, otherwise the parsed FunPay account id. */
function resolveSellerAccountId(state: Awaited<ReturnType<typeof loadState>>): string | null {
  const explicit = state.settings.sellerAccountId?.trim();
  if (explicit) return explicit;
  const parsed = state.cache?.accountInfo?.userId;
  return parsed ? String(parsed) : null;
}

/** Build a Supabase client bound to the current settings and the freshest operator session. */
async function createCloudClient(options?: { url?: string; key?: string }): Promise<{ client: SupabaseClient; userId: string | null }> {
  const state = await loadState();
  const url = options?.url || state.settings.supabaseUrl || DEFAULT_SUPABASE_CONFIG.url;
  const key = options?.key || state.settings.supabaseKey || DEFAULT_SUPABASE_CONFIG.anonKey;

  const client = new SupabaseClient(url, key);
  const session = await loadFreshSession(url, key);
  client.setAccessToken(session?.accessToken ?? null);

  return { client, userId: session?.userId ?? null };
}

// Initialize on extension installation
chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  debugLog(state.settings.developerMode, 'FanPay Hotkeys extension installed or updated.');

  // Set up periodic shift overrun check (every 10 minutes)
  try {
    chrome.alarms.create('CHECK_SHIFT_OVERRUN', { periodInMinutes: 10 });
  } catch {
    // alarms not available
  }

  // Periodic team presence heartbeat (public.operator_status.last_heartbeat_at)
  try {
    chrome.alarms.create('CLOUD_HEARTBEAT', { periodInMinutes: 5 });
  } catch {
    // alarms not available
  }

  // Automatically inject content scripts into all existing open FunPay tabs
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
      chrome.tabs.query({ url: ['*://funpay.com/*', '*://*.funpay.com/*'] }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }).catch(() => {});
            chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ['content.css']
            }).catch(() => {});
          }
        }
      });
    }
  } catch {
    // ignore
  }
});

// Check for unclosed shifts when browser starts
chrome.runtime.onStartup?.addListener(async () => {
  try {
    const shiftState = await loadShiftState();
    if (shiftState.shiftActive && shiftState.shiftStartTime) {
      const elapsedHours = (Date.now() - shiftState.shiftStartTime) / (3600 * 1000);
      if (elapsedHours >= 3) {
        chrome.notifications?.create('fphk_shift_startup_alert', {
          type: 'basic',
          iconUrl: 'assets/icon128.png',
          title: '⚠️ Незавершённая смена FunPay',
          message: `Обнаружена активная смена оператора ${shiftState.currentOperator || 'Оператор 1'}, начатая более ${Math.floor(elapsedHours)} ч. назад. Не забудьте проверить и завершить смену!`
        });
      }
    }
  } catch {
    // ignore
  }
});

// Alarm handler for shift overrun protection
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'CHECK_SHIFT_OVERRUN') {
    try {
      const state = await loadState();
      const shiftState = await loadShiftState();
      const thresholdHours = state.settings.shiftOverrunAlertHours ?? 8;

      if (thresholdHours > 0 && shiftState.shiftActive && shiftState.shiftStartTime) {
        const elapsedHours = (Date.now() - shiftState.shiftStartTime) / (3600 * 1000);
        if (elapsedHours >= thresholdHours) {
          chrome.notifications?.create('fphk_shift_overrun_alert', {
            type: 'basic',
            iconUrl: 'assets/icon128.png',
            title: '⏱️ Внимание: длительная смена FunPay',
            message: `Смена оператора ${shiftState.currentOperator || 'Оператор 1'} длится уже ${Math.floor(elapsedHours)} ч. (порог: ${thresholdHours} ч.). Пожалуйста, завершите смену, если закончили работу.`
          });
        }
      }
    } catch {
      // ignore
    }
  }
});

// Open dashboard when clicking notification
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'CLOUD_HEARTBEAT') return;

  try {
    const state = await loadState();
    if (!state.settings.cloudSyncEnabled) return;

    const { client, userId } = await createCloudClient();
    if (!userId) return;

    const shiftState = await loadShiftState();
    const stored = await chrome.storage.local.get(['fphk_current_cloud_shift_id']);
    const cloudShiftId = (stored.fphk_current_cloud_shift_id as string | undefined) || null;
    const sellerAccountId = resolveSellerAccountId(state);

    if (shiftState.shiftActive && cloudShiftId) {
      await client.upsertOperatorStatus({
        userId,
        status: 'on_shift',
        activeShiftId: cloudShiftId,
        sellerAccountId,
        appVersion: getAppVersion()
      });
    } else {
      await client.upsertOperatorStatus({
        userId,
        status: 'online',
        activeShiftId: null,
        sellerAccountId: null,
        appVersion: getAppVersion()
      });
    }
  } catch (e) {
    console.warn('[Supabase] heartbeat error:', e);
  }
});

chrome.notifications?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Auto-sync configuration helper (safe no-op)
function setupAutoSyncAlarm(_intervalMinutes: number) {
  // Reserved for explicit sync triggers without background alarm polling
}

// Notify all open FunPay tabs about state changes
async function notifyAllFunPayTabs() {
  const state = await loadState();
  chrome.tabs.query({ url: 'https://funpay.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'STATE_UPDATED',
          payload: state
        }).catch(() => {});
      }
    }
  });
}

// Central Message Dispatcher
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_STATE': {
          const state = await loadState();
          sendResponse({ success: true, state });
          break;
        }

        case 'UPDATE_SETTINGS': {
          const updated = await updateSettings(message.payload);
          if (message.payload.autoSyncIntervalMinutes !== undefined) {
            setupAutoSyncAlarm(updated.autoSyncIntervalMinutes);
          }
          await notifyAllFunPayTabs();
          sendResponse({ success: true, settings: updated });
          break;
        }

        case 'SET_SELECTED_PROFILE': {
          const updated = await updateSettings({ selectedProfileId: message.payload.profileId });
          await notifyAllFunPayTabs();
          sendResponse({ success: true, settings: updated });
          break;
        }

        case 'SAVE_PROFILE': {
          await upsertProfile(message.payload);
          await notifyAllFunPayTabs();
          const state = await loadState();
          sendResponse({ success: true, state });
          break;
        }

        case 'DELETE_PROFILE': {
          const res = await deleteProfile(message.payload.profileId);
          // If deleted active profile, reset to first available
          const state = await loadState();
          if (state.settings.selectedProfileId === message.payload.profileId) {
            await updateSettings({ selectedProfileId: res.profiles[0]?.id || '' });
          }
          await notifyAllFunPayTabs();
          const newState = await loadState();
          sendResponse({ success: true, state: newState });
          break;
        }

        case 'SAVE_TEMPLATE': {
          await upsertTemplate(message.payload);
          await notifyAllFunPayTabs();
          const state = await loadState();
          sendResponse({ success: true, state });
          break;
        }

        case 'DELETE_TEMPLATE': {
          await deleteTemplate(message.payload.templateId);
          await notifyAllFunPayTabs();
          const state = await loadState();
          sendResponse({ success: true, state });
          break;
        }

        case 'REORDER_TEMPLATES': {
          const state = await loadState();
          const idOrder: string[] = message.payload.templateIds;
          const reordered = state.templates.map(t => {
            const idx = idOrder.indexOf(t.id);
            return idx !== -1 ? { ...t, sortOrder: idx + 1 } : t;
          });
          await saveTemplates(reordered);
          await notifyAllFunPayTabs();
          sendResponse({ success: true });
          break;
        }

        case 'TEST_API_CONNECTION': {
          const state = await loadState();
          const keyToTest = message.payload?.goldenKey ?? state.settings.goldenKey;
          const result = await FunPayClient.getInstance().testConnection(
            keyToTest,
            state.settings.developerMode
          );
          sendResponse(result);
          break;
        }

        case 'SYNC_DATA': {
          const state = await loadState();
          const syncResult = await FunPayClient.getInstance().syncAllData(
            state.settings.goldenKey,
            state.settings.developerMode,
            state.cache.orders || [],
            false
          );

          if (syncResult.success) {
            const newCache = {
              lastSyncTimestamp: Date.now(),
              accountInfo: syncResult.account,
              orders: syncResult.orders,
              diagnosticReport: syncResult.diagnostics?.diagnosticReport,
              error: null
            };
            await saveCache(newCache);
            await notifyAllFunPayTabs();
            sendResponse({ success: true, cache: newCache, syncResult });
          } else {
            const updatedCache = {
              ...state.cache,
              diagnosticReport: syncResult.diagnostics?.diagnosticReport || state.cache?.diagnosticReport,
              error: syncResult.error || 'Ошибка синхронизации'
            };
            await saveCache(updatedCache);
            sendResponse({ success: false, error: syncResult.error, diagnostics: syncResult.diagnostics });
          }
          break;
        }

        case 'FETCH_ALL_HISTORY': {
          const state = await loadState();
          const syncResult = await FunPayClient.getInstance().syncAllData(
            state.settings.goldenKey,
            state.settings.developerMode,
            state.cache.orders || [],
            true, // full history mode
            100   // max pages limit for full history scan
          );

          if (syncResult.success) {
            const newCache = {
              lastSyncTimestamp: Date.now(),
              accountInfo: syncResult.account,
              orders: syncResult.orders,
              diagnosticReport: syncResult.diagnostics?.diagnosticReport,
              error: null
            };
            await saveCache(newCache);
            await notifyAllFunPayTabs();
            sendResponse({ success: true, cache: newCache, syncResult });
          } else {
            const updatedCache = {
              ...state.cache,
              diagnosticReport: syncResult.diagnostics?.diagnosticReport || state.cache?.diagnosticReport,
              error: syncResult.error || 'Ошибка загрузки полной истории'
            };
            await saveCache(updatedCache);
            sendResponse({ success: false, error: syncResult.error, diagnostics: syncResult.diagnostics });
          }
          break;
        }

        case 'GET_SYNC_PROGRESS': {
          chrome.storage.local.get(['fphk_sync_progress'], (result) => {
            sendResponse({ success: true, progress: result.fphk_sync_progress || null });
          });
          break;
        }

        case 'CLEAR_API_CREDENTIALS': {
          await clearApiKey();
          await notifyAllFunPayTabs();
          sendResponse({ success: true });
          break;
        }

        case 'EXPORT_BACKUP': {
          const backup = await exportSettings();
          sendResponse({ success: true, backup });
          break;
        }

        case 'IMPORT_BACKUP': {
          const newState = await importSettings(message.payload.backup, message.payload.overwrite);
          await notifyAllFunPayTabs();
          sendResponse({ success: true, state: newState });
          break;
        }

        case 'OPEN_OPTIONS': {
          chrome.runtime.openOptionsPage();
          sendResponse({ success: true });
          break;
        }

        case 'GET_SHIFT_STATE': {
          const shiftState = await loadShiftState();
          sendResponse({ success: true, shiftState });
          break;
        }

        case 'START_SHIFT': {
          const shiftState = await startShift(message.payload?.operatorName, message.payload?.note);
          let cloudShiftId: string | null = null;

          try {
            const state = await loadState();
            if (state.settings.cloudSyncEnabled) {
              const { client, userId } = await createCloudClient();
              const sellerAccountId = resolveSellerAccountId(state);

              if (userId && sellerAccountId) {
                cloudShiftId = generateUuid();
                const started = await client.startShift({
                  shiftId: cloudShiftId,
                  userId,
                  sellerAccountId,
                  startTimeMs: shiftState.shiftStartTime || Date.now()
                });

                if (started.success) {
                  await chrome.storage.local.set({ fphk_current_cloud_shift_id: cloudShiftId });
                  await client.upsertOperatorStatus({
                    userId,
                    status: 'on_shift',
                    activeShiftId: cloudShiftId,
                    sellerAccountId,
                    appVersion: getAppVersion()
                  });
                } else {
                  cloudShiftId = null;
                  console.warn('[Supabase] start shift error:', started.error);
                }
              } else if (!userId) {
                console.warn('[Supabase] смена создана только локально: оператор не вошёл в облако команды');
              } else {
                console.warn('[Supabase] смена создана только локально: не определён seller_account_id');
              }
            }
          } catch (e) {
            console.warn('[Supabase] start shift sync error:', e);
          }
          sendResponse({ success: true, shiftState, cloudShiftId });
          break;
        }

        case 'STOP_SHIFT': {
          let cloudShiftId: string | null = null;
          try {
            const stored = await chrome.storage.local.get(['fphk_current_cloud_shift_id']);
            cloudShiftId = (stored.fphk_current_cloud_shift_id as string | undefined) || null;
          } catch {
            cloudShiftId = null;
          }

          // The local record reuses the cloud UUID so both stores agree on one identifier.
          const result = await stopShift(message.payload?.note, cloudShiftId ? { id: cloudShiftId } : undefined);

          try {
            const state = await loadState();
            if (state.settings.cloudSyncEnabled && result.completedShift && cloudShiftId) {
              const { client, userId } = await createCloudClient();

              const finished = await client.finishShift({
                shiftId: cloudShiftId,
                endTimeMs: result.completedShift.endTime
              });
              if (!finished.success) {
                console.warn('[Supabase] finish shift error:', finished.error);
              }

              if (userId) {
                await client.upsertOperatorStatus({
                  userId,
                  status: 'online',
                  activeShiftId: null,
                  sellerAccountId: null,
                  appVersion: getAppVersion()
                });
              }

              await chrome.storage.local.remove(['fphk_current_cloud_shift_id']);
            }
          } catch (e) {
            console.warn('[Supabase] stop shift sync error:', e);
          }
          sendResponse({ success: true, ...result, cloudShiftId });
          break;
        }

        case 'GET_SHIFT_HISTORY': {
          const localHistory = await loadShiftHistory();
          try {
            const state = await loadState();
            if (state.settings.cloudSyncEnabled) {
              const { client, userId } = await createCloudClient();
              const cloudShifts = await client.fetchCloudShifts(150, {
                localOrders: state.cache.orders || [],
                sellerSharePercent: state.settings.sellerSharePercent ?? 10,
                currentUserId: userId ?? undefined
              });
              if (cloudShifts && cloudShifts.length > 0) {
                const idSet = new Set(cloudShifts.map(s => s.id));
                const combined = [...cloudShifts];
                for (const loc of localHistory) {
                  if (!idSet.has(loc.id)) {
                    combined.push(loc);
                  }
                }
                combined.sort((a, b) => b.startTime - a.startTime);
                sendResponse({ success: true, history: combined });
                break;
              }
            }
          } catch (e) {
            console.warn('[Supabase] get shift history error:', e);
          }
          sendResponse({ success: true, history: localHistory });
          break;
        }

        case 'FETCH_TEAM_STATUS': {
          try {
            const { client } = await createCloudClient();
            const team = await client.fetchTeamOnlineStatus();
            sendResponse({ success: true, team });
          } catch (err: unknown) {
            sendResponse({ success: false, error: err instanceof Error ? err.message : 'Error fetching team status' });
          }
          break;
        }

        case 'TEST_SUPABASE_CONNECTION': {
          try {
            const { client } = await createCloudClient({ url: message.payload?.url, key: message.payload?.key });
            const testResult = await client.testConnection();
            sendResponse(testResult);
          } catch (err: unknown) {
            sendResponse({ success: false, error: err instanceof Error ? err.message : 'Connection failed' });
          }
          break;
        }

        case 'SAVE_SHIFT': {
          if (message.payload?.shift) {
            await saveShift(message.payload.shift);
            const history = await loadShiftHistory();
            sendResponse({ success: true, history });
          } else {
            sendResponse({ success: false, error: 'Shift object required' });
          }
          break;
        }

        case 'DELETE_SHIFT': {
          if (message.payload?.shiftId) {
            await deleteShift(message.payload.shiftId);
            const history = await loadShiftHistory();
            sendResponse({ success: true, history });
          } else {
            sendResponse({ success: false, error: 'Shift ID required' });
          }
          break;
        }

        case 'RECALCULATE_SHIFTS_EARNINGS': {
          const state = await loadState();
          const orders = state.cache.orders || [];
          const percent = state.settings.sellerSharePercent ?? 10.0;
          const history = await recalculateShifts(orders, percent);
          sendResponse({ success: true, history });
          break;
        }

        // ==================================================================
        // Team cloud: operator sign-in and order synchronisation (schema v2.4)
        // ==================================================================
        case 'GET_CLOUD_AUTH_STATE': {
          const session = await loadAuthSession();
          sendResponse({ success: true, auth: toAuthState(session) });
          break;
        }

        case 'SIGN_IN_CLOUD': {
          const state = await loadState();
          const url = state.settings.supabaseUrl || DEFAULT_SUPABASE_CONFIG.url;
          const key = state.settings.supabaseKey || DEFAULT_SUPABASE_CONFIG.anonKey;
          try {
            const session = await new SupabaseAuth(url, key).signInWithPassword(
              message.payload?.email || '',
              message.payload?.password || ''
            );
            await saveAuthSession(session);
            sendResponse({ success: true, auth: toAuthState(session) });
          } catch (err) {
            sendResponse({ success: false, error: err instanceof Error ? err.message : 'Не удалось войти' });
          }
          break;
        }

        case 'SIGN_OUT_CLOUD': {
          const session = await loadAuthSession();
          if (session) {
            const state = await loadState();
            await new SupabaseAuth(
              state.settings.supabaseUrl || DEFAULT_SUPABASE_CONFIG.url,
              state.settings.supabaseKey || DEFAULT_SUPABASE_CONFIG.anonKey
            ).signOut(session.accessToken);
          }
          await clearAuthSession();
          sendResponse({ success: true, auth: toAuthState(null) });
          break;
        }

        case 'FETCH_CLOUD_SHOPS': {
          const { client } = await createCloudClient();
          const shops = await client.fetchAuthorizedShops();
          sendResponse({ success: true, shops });
          break;
        }

        case 'SYNC_ORDERS_TO_CLOUD': {
          const state = await loadState();
          const sellerAccountId = (message.payload?.sellerAccountId || '').trim() || resolveSellerAccountId(state) || '';
          const orders = state.cache.orders || [];
          const { client, userId } = await createCloudClient();

          if (!userId) {
            sendResponse({
              success: false,
              error: 'Оператор не вошёл в облако команды: синхронизация заказов недоступна'
            });
            break;
          }

          const report = await client.syncOrdersBatch(sellerAccountId, orders);
          sendResponse({ success: report.errors.length === 0, report });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
          break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Internal error';
      sendResponse({ success: false, error: msg });
    }
  })();

  return true; // Keep message channel open for async response
});
