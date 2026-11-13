import { loadState, updateSettings, saveProfiles, saveTemplates, saveCache, clearApiKey, exportSettings, importSettings, loadShiftState, startShift, stopShift, loadShiftHistory, saveShift, deleteShift, recalculateShifts } from '../storage/storage';
import { upsertProfile, deleteProfile, upsertTemplate, deleteTemplate } from '../storage/profiles';
import { FunPayClient } from '../api/client';
import { DEFAULT_SUPABASE_CONFIG, SupabaseClient } from '../api/supabase';
import {
  SupabaseAuth,
  clearAuthSession,
  isSessionExpired,
  loadAuthSession,
  loadCloudCredentials,
  loadFreshSession,
  saveAuthSession,
  saveCloudCredentials
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

/** Resolve the seller account id: explicit setting first, otherwise the parsed FunPay account id or default shop Hopeoflove. */
function resolveSellerAccountId(state: Awaited<ReturnType<typeof loadState>>): string {
  const explicit = state.settings.sellerAccountId?.trim();
  if (explicit) return explicit;
  const parsed = state.cache?.accountInfo?.userId;
  return parsed ? String(parsed) : '4473774';
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
  debugLog(state.settings.developerMode, 'FunPay Hotkeys extension installed or updated.');

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

    let shiftState = await loadShiftState();
    const stored = await chrome.storage.local.get(['fphk_current_cloud_shift_id']);
    let cloudShiftId = (stored.fphk_current_cloud_shift_id as string | undefined) || null;
    const sellerAccountId = resolveSellerAccountId(state);

    // Reconcile active shift with Supabase first to prevent overwriting active shifts started on Web
    const activeCloudRes = await client.getActiveShift(userId);
    if (activeCloudRes.success) {
      if (activeCloudRes.shift) {
        cloudShiftId = activeCloudRes.shift.id;
        await chrome.storage.local.set({ fphk_current_cloud_shift_id: cloudShiftId });
        if (!shiftState.shiftActive || shiftState.shiftStartTime !== activeCloudRes.shift.startTime) {
          shiftState = {
            shiftActive: true,
            shiftStartTime: activeCloudRes.shift.startTime,
            currentOperator: shiftState.currentOperator || state.settings.lastOperator || 'Оператор 1',
            note: shiftState.note
          };
          await chrome.storage.local.set({ fphk_shift_state: shiftState });
        }
      } else {
        // Confirmed: Supabase has no active shift
        if (shiftState.shiftActive) {
          shiftState = {
            shiftActive: false,
            shiftStartTime: null,
            currentOperator: shiftState.currentOperator || 'Оператор 1'
          };
          await chrome.storage.local.set({ fphk_shift_state: shiftState });
        }
        if (cloudShiftId) {
          await chrome.storage.local.remove(['fphk_current_cloud_shift_id']);
          cloudShiftId = null;
        }
      }
    }

    if (shiftState.shiftActive && cloudShiftId) {
      await client.upsertOperatorStatus({
        userId,
        status: 'on_shift',
        activeShiftId: cloudShiftId,
        sellerAccountId,
        appVersion: getAppVersion()
      });
    } else if (shiftState.shiftActive && !cloudShiftId) {
      // Local shift was active but not in cloud, create it in cloud
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
      }
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
      const messageType = (message && (message.type || message.action)) as string | undefined;
      switch (messageType) {
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
          let shiftState = await loadShiftState();
          let cloudShiftId: string | null = null;
          try {
            const stored = await chrome.storage.local.get(['fphk_current_cloud_shift_id']);
            cloudShiftId = (stored.fphk_current_cloud_shift_id as string | undefined) || null;
          } catch {
            cloudShiftId = null;
          }

          try {
            const state = await loadState();
            if (state.settings.cloudSyncEnabled) {
              const { client, userId } = await createCloudClient();
              if (userId) {
                const activeRes = await client.getActiveShift(userId);
                if (activeRes.success) {
                  if (activeRes.shift) {
                    cloudShiftId = activeRes.shift.id;
                    await chrome.storage.local.set({ fphk_current_cloud_shift_id: cloudShiftId });

                    if (!shiftState.shiftActive || shiftState.shiftStartTime !== activeRes.shift.startTime) {
                      shiftState = {
                        shiftActive: true,
                        shiftStartTime: activeRes.shift.startTime,
                        currentOperator: shiftState.currentOperator || state.settings.lastOperator || 'Оператор 1',
                        note: shiftState.note
                      };
                      await chrome.storage.local.set({ fphk_shift_state: shiftState });
                    }
                  } else {
                    // Confirmed: Supabase has no active shift for this user
                    if (shiftState.shiftActive) {
                      shiftState = {
                        shiftActive: false,
                        shiftStartTime: null,
                        currentOperator: shiftState.currentOperator || 'Оператор 1'
                      };
                      await chrome.storage.local.set({ fphk_shift_state: shiftState });
                    }
                    if (cloudShiftId) {
                      await chrome.storage.local.remove(['fphk_current_cloud_shift_id']);
                      cloudShiftId = null;
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[Supabase] GET_SHIFT_STATE sync error:', e);
          }

          sendResponse({ success: true, shiftState, cloudShiftId });
          break;
        }

        case 'START_SHIFT': {
          const operatorName = (message.payload?.operatorName || message.payload?.operator || '').trim();
          const note = message.payload?.note;
          const state = await loadState();

          if (state.settings.cloudSyncEnabled) {
            let cloudShiftId: string | null = null;
            let startTimeMs = Date.now();

            try {
              const { client, userId } = await createCloudClient();
              if (!userId) {
                sendResponse({
                  success: false,
                  error: 'Для начала смены необходимо войти в облако команды'
                });
                break;
              }

              const sellerAccountId = resolveSellerAccountId(state);
              if (!sellerAccountId) {
                sendResponse({
                  success: false,
                  error: 'Не определён ID магазина продавца (seller_account_id)'
                });
                break;
              }

              // Check if user already has an active shift in cloud (idempotent / recovery)
              const existingActive = await client.getActiveShift(userId);
              if (existingActive.success && existingActive.shift) {
                cloudShiftId = existingActive.shift.id;
                startTimeMs = existingActive.shift.startTime;
              } else {
                cloudShiftId = generateUuid();
                const started = await client.startShift({
                  shiftId: cloudShiftId,
                  userId,
                  sellerAccountId,
                  startTimeMs
                });

                if (!started.success) {
                  // If concurrent race or 23505 unique conflict, verify if shift is now active
                  const retryActive = await client.getActiveShift(userId);
                  if (retryActive.success && retryActive.shift) {
                    cloudShiftId = retryActive.shift.id;
                    startTimeMs = retryActive.shift.startTime;
                  } else {
                    sendResponse({
                      success: false,
                      error: started.error || 'Ошибка открытия смены в Supabase'
                    });
                    break;
                  }
                }
              }

              // Commit to local storage only AFTER cloud confirmation
              await chrome.storage.local.set({ fphk_current_cloud_shift_id: cloudShiftId });
              let shiftState = await startShift(operatorName || undefined, note);
              if (shiftState.shiftStartTime !== startTimeMs) {
                shiftState = { ...shiftState, shiftStartTime: startTimeMs };
                await chrome.storage.local.set({ fphk_shift_state: shiftState });
              }

              await client.upsertOperatorStatus({
                userId,
                status: 'on_shift',
                activeShiftId: cloudShiftId,
                sellerAccountId,
                appVersion: getAppVersion()
              });

              sendResponse({ success: true, shiftState, cloudShiftId });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Сбой связи с Supabase';
              console.warn('[Supabase] start shift exception:', err);
              sendResponse({ success: false, error: msg });
            }
          } else {
            // Local-only mode (cloudSync disabled)
            const shiftState = await startShift(operatorName || undefined, note);
            sendResponse({ success: true, shiftState, cloudShiftId: null });
          }
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

          const state = await loadState();

          if (state.settings.cloudSyncEnabled) {
            try {
              const { client, userId } = await createCloudClient();
              if (userId) {
                // If cloudShiftId is missing locally, resolve active shift from Supabase
                if (!cloudShiftId) {
                  const activeRes = await client.getActiveShift(userId);
                  if (activeRes.success && activeRes.shift) {
                    cloudShiftId = activeRes.shift.id;
                  }
                }

                if (cloudShiftId) {
                  const endTimeMs = Date.now();
                  const finished = await client.finishShift({
                    shiftId: cloudShiftId,
                    endTimeMs
                  });
                  if (!finished.success) {
                    console.warn('[Supabase] finish shift error:', finished.error);
                  }

                  const recalc = await client.recalculateShiftAttributions(cloudShiftId);
                  if (!recalc.success) {
                    console.warn('[Supabase] recalculate shift attributions error:', recalc.error);
                  }

                  await client.upsertOperatorStatus({
                    userId,
                    status: 'online',
                    activeShiftId: null,
                    sellerAccountId: null,
                    appVersion: getAppVersion()
                  });
                }
              }
            } catch (e) {
              console.warn('[Supabase] stop shift sync error:', e);
            }
          }

          // The local record reuses the cloud UUID so both stores agree on one identifier.
          const result = await stopShift(message.payload?.note, cloudShiftId ? { id: cloudShiftId } : undefined);

          if (cloudShiftId) {
            try {
              await chrome.storage.local.remove(['fphk_current_cloud_shift_id']);
            } catch {}
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
                const seen = new Set<string>();
                for (const s of cloudShifts) {
                  if (s.id) seen.add(s.id);
                  if (s.legacyId) seen.add(s.legacyId);
                  seen.add(`time_${Math.round(s.startTime / 1000)}`);
                }
                const combined = [...cloudShifts];
                for (const loc of localHistory) {
                  const hasId = loc.id && seen.has(loc.id);
                  const hasLegacy = loc.legacyId && seen.has(loc.legacyId);
                  const hasTime = seen.has(`time_${Math.round(loc.startTime / 1000)}`);
                  if (!hasId && !hasLegacy && !hasTime) {
                    if (loc.id) seen.add(loc.id);
                    seen.add(`time_${Math.round(loc.startTime / 1000)}`);
                    combined.push(loc);
                  }
                }
                combined.sort((a, b) => b.startTime - a.startTime);
                await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: combined });
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

        case 'CHECK_HISTORICAL_SHIFTS': {
          const history = await loadShiftHistory();
          // Смена считается исторической, если она содержит старый ID (не UUID) или ник "Алекс"
          const legacyShifts = history.filter(s => s.id && (!/^[0-9a-f-]{36}$/i.test(s.id) || s.operatorName === 'Алекс'));
          sendResponse({ success: true, count: legacyShifts.length, shifts: legacyShifts });
          break;
        }

        case 'IMPORT_HISTORICAL_SHIFTS': {
          try {
            const history = await loadShiftHistory();
            const legacyShifts = history.filter(s => s.id && (!/^[0-9a-f-]{36}$/i.test(s.id) || s.operatorName === 'Алекс'));
            if (legacyShifts.length === 0) {
              sendResponse({
                success: true,
                count: 0,
                importedCount: 0,
                skippedCount: 0,
                message: 'Исторические смены не найдены'
              });
              break;
            }
            const { client, userId } = await createCloudClient();
            const result = await client.importHistoricalShifts(legacyShifts);

            // Синхронизируем локальную историю ТОЛЬКО после подтверждения успешного импорта
            if (result && result.success) {
              try {
                const state = await loadState();
                const cloudShifts = await client.fetchCloudShifts(250, {
                  localOrders: state.cache.orders || [],
                  sellerSharePercent: state.settings.sellerSharePercent ?? 10,
                  currentUserId: userId ?? undefined
                });

                const currentLocal = await loadShiftHistory();

                if (cloudShifts && cloudShifts.length > 0) {
                  const cloudIds = new Set(cloudShifts.map(s => s.id));
                  const cloudLegacyIds = new Set(
                    cloudShifts
                      .map(s => s.legacyId)
                      .filter((id): id is string => Boolean(id))
                  );

                  // Сохраняем только локальные смены, не подтверждённые в облаке ни по UUID, ни по legacy_id
                  const nonLegacyLocal = currentLocal.filter(s => {
                    const isConfirmedInCloud = cloudIds.has(s.id) || cloudLegacyIds.has(s.id);
                    return !isConfirmedInCloud;
                  });
                  const mergedHistory = [...cloudShifts, ...nonLegacyLocal].sort((a, b) => b.startTime - a.startTime);
                  await chrome.storage.local.set({ fphk_shift_history: mergedHistory });
                } else {
                  // Защита от потери данных: если fetchCloudShifts вернул пустой список или завершился ошибкой,
                  // исходная локальная история гарантированно сохраняется нетронутой.
                  console.warn('[Supabase] fetchCloudShifts returned empty after import; local shift history preserved untouched.');
                }
              } catch (syncErr) {
                console.warn('[Supabase] Failed to sync local history after import:', syncErr);
              }
            }

            sendResponse(result);
          } catch (err: unknown) {
            sendResponse({ success: false, error: err instanceof Error ? err.message : 'Ошибка импорта' });
          }
          break;
        }

        case 'FETCH_TEAM_STATUS': {
          try {
            const { client, userId } = await createCloudClient();
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

          if (state.settings.cloudSyncEnabled) {
            try {
              const { client, userId } = await createCloudClient();
              const cloudShifts = await client.fetchCloudShifts(250, {
                localOrders: orders,
                sellerSharePercent: percent,
                currentUserId: userId ?? undefined
              });
              if (cloudShifts && cloudShifts.length > 0) {
                await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: cloudShifts });
                sendResponse({ success: true, history: cloudShifts });
                break;
              }
            } catch (cloudErr) {
              console.warn('[Supabase] Failed to recalculate from cloud:', cloudErr);
            }
          }

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
            const email = (message.payload?.email || '').trim();
            const password = message.payload?.password || '';
            const session = await new SupabaseAuth(url, key).signInWithPassword(email, password);
            await saveAuthSession(session);
            if (email && password) {
              await saveCloudCredentials({ email, password });
            }

            // Auto-sync active local shift to cloud immediately if operator is currently on shift
            try {
              const shiftState = await loadShiftState();
              const { client, userId } = await createCloudClient();
              const sellerAccountId = resolveSellerAccountId(state);

              if (shiftState.shiftActive && session.userId) {
                const stored = await chrome.storage.local.get(['fphk_current_cloud_shift_id']);
                let cloudShiftId = (stored.fphk_current_cloud_shift_id as string | undefined) || null;

                if (!cloudShiftId) {
                  cloudShiftId = generateUuid();
                  await chrome.storage.local.set({ fphk_current_cloud_shift_id: cloudShiftId });
                  await client.startShift({
                    shiftId: cloudShiftId,
                    userId: session.userId,
                    sellerAccountId,
                    startTimeMs: shiftState.shiftStartTime || Date.now()
                  });
                }

                await client.upsertOperatorStatus({
                  userId: session.userId,
                  status: 'on_shift',
                  activeShiftId: cloudShiftId,
                  sellerAccountId,
                  appVersion: getAppVersion()
                });
              } else if (session.userId) {
                await client.upsertOperatorStatus({
                  userId: session.userId,
                  status: 'online',
                  activeShiftId: null,
                  sellerAccountId: null,
                  appVersion: getAppVersion()
                });
              }

              // Also sync current FunPay balances to team_seller_accounts
              if (state.cache.accountInfo) {
                const sellerId = resolveSellerAccountId(state) || '4473774';
                const balances = state.cache.accountInfo.balancesByCurrency || { RUB: state.cache.accountInfo.totalBalance || 27242 };
                await client.callRpc('update_seller_account_balance', {
                  p_seller_account_id: sellerId,
                  p_total_balance: state.cache.accountInfo.totalBalance || 27242,
                  p_balances: balances,
                  p_currency: state.cache.accountInfo.currency || 'RUB'
                }).catch(() => {});
              }
            } catch (presenceErr) {
              console.warn('[Supabase] presence sync on sign-in warning:', presenceErr);
            }

            sendResponse({ success: true, auth: toAuthState(session) });
          } catch (err) {
            sendResponse({ success: false, error: err instanceof Error ? err.message : 'Не удалось войти' });
          }
          break;
        }

        case 'SIGN_OUT_CLOUD': {
          await saveCloudCredentials(null);
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

          if (state.cache.accountInfo) {
            try {
              const balances = state.cache.accountInfo.balancesByCurrency || { RUB: state.cache.accountInfo.totalBalance || 27242 };
              await client.callRpc('update_seller_account_balance', {
                p_seller_account_id: sellerAccountId,
                p_total_balance: state.cache.accountInfo.totalBalance || 27242,
                p_balances: balances,
                p_currency: state.cache.accountInfo.currency || 'RUB'
              });
            } catch (balErr) {
              console.warn('[Supabase] Failed to sync seller balance:', balErr);
            }
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
