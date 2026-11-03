import { loadState, updateSettings, saveProfiles, saveTemplates, saveCache, clearApiKey, exportSettings, importSettings, loadShiftState, startShift, stopShift, loadShiftHistory, saveShift, deleteShift, recalculateShifts } from '../storage/storage';
import { upsertProfile, deleteProfile, upsertTemplate, deleteTemplate } from '../storage/profiles';
import { FunPayClient } from '../api/client';
import { debugLog } from '../shared/utils';

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
          sendResponse({ success: true, shiftState });
          break;
        }

        case 'STOP_SHIFT': {
          const result = await stopShift(message.payload?.note);
          sendResponse({ success: true, ...result });
          break;
        }

        case 'GET_SHIFT_HISTORY': {
          const history = await loadShiftHistory();
          sendResponse({ success: true, history });
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
