import { AppSettings, BackupData, CompletedShift, ExtensionState, FunPayOrder, Profile, ShiftState, SyncCache, Template } from '../shared/types';
import { DEFAULT_PROFILES, DEFAULT_SETTINGS, DEFAULT_TEMPLATES } from '../shared/constants';
import { calculateShiftEarnings } from '../shared/utils';

const STORAGE_KEYS = {
  SETTINGS: 'fphk_settings',
  PROFILES: 'fphk_profiles',
  TEMPLATES: 'fphk_templates',
  CACHE: 'fphk_cache',
  SHIFT_STATE: 'fphk_shift_state',
  SHIFT_HISTORY: 'fphk_shift_history'
};

/**
 * Load complete state from chrome.storage.local with automatic defaults initialization
 */
export async function loadState(): Promise<ExtensionState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.PROFILES, STORAGE_KEYS.TEMPLATES, STORAGE_KEYS.CACHE],
      (result) => {
        let settings: AppSettings = result[STORAGE_KEYS.SETTINGS];
        let profiles: Profile[] = result[STORAGE_KEYS.PROFILES];
        let templates: Template[] = result[STORAGE_KEYS.TEMPLATES];
        let cache: SyncCache = result[STORAGE_KEYS.CACHE];

        let needsSave = false;

        if (!settings) {
          settings = { ...DEFAULT_SETTINGS };
          needsSave = true;
        }

        if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
          profiles = [...DEFAULT_PROFILES];
          needsSave = true;
        }

        if (!templates || !Array.isArray(templates) || templates.length === 0) {
          templates = [...DEFAULT_TEMPLATES];
          needsSave = true;
        }

        if (!cache) {
          cache = {
            lastSyncTimestamp: null,
            accountInfo: null,
            orders: [],
            error: null
          };
          needsSave = true;
        }

        if (needsSave) {
          chrome.storage.local.set({
            [STORAGE_KEYS.SETTINGS]: settings,
            [STORAGE_KEYS.PROFILES]: profiles,
            [STORAGE_KEYS.TEMPLATES]: templates,
            [STORAGE_KEYS.CACHE]: cache
          });
        }

        resolve({ settings, profiles, templates, cache });
      }
    );
  });
}

/**
 * Save settings changes
 */
export async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const state = await loadState();
  const updated: AppSettings = { ...state.settings, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
  return updated;
}

/**
 * Save all profiles
 */
export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
}

/**
 * Save all templates
 */
export async function saveTemplates(templates: Template[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.TEMPLATES]: templates });
}

/**
 * Save sync cache (orders, account info, balance)
 */
export async function saveCache(cache: SyncCache): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
}

/**
 * Remove API golden_key securely
 */
export async function clearApiKey(): Promise<void> {
  const state = await loadState();
  const updated = { ...state.settings, goldenKey: '' };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
}

/**
 * Export settings & templates into a clean JSON structure
 */
export async function exportSettings(): Promise<BackupData> {
  const state = await loadState();
  const shifts = await loadShiftHistory();
  // Strip sensitive credentials from exported backup file
  const { goldenKey: _, ...safeSettings } = state.settings;
  return {
    version: '1.0.0',
    exportDate: new Date().toISOString(),
    settings: safeSettings,
    profiles: state.profiles,
    templates: state.templates,
    shifts
  };
}

/**
 * Import settings & templates from backup
 */
export async function importSettings(backup: BackupData, overwrite: boolean): Promise<ExtensionState> {
  if (!backup || !Array.isArray(backup.profiles) || !Array.isArray(backup.templates)) {
    throw new Error('Некорректный формат файла резервной копии.');
  }

  const current = await loadState();

  let finalProfiles: Profile[];
  let finalTemplates: Template[];
  let finalSettings: AppSettings;

  if (overwrite) {
    finalProfiles = backup.profiles;
    finalTemplates = backup.templates;
    finalSettings = {
      ...current.settings,
      ...backup.settings,
      goldenKey: current.settings.goldenKey // Preserve active credentials
    };
    if (Array.isArray(backup.shifts)) {
      await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: backup.shifts });
    }
  } else {
    // Merge mode: add non-existing profiles & templates
    const existingProfileIds = new Set(current.profiles.map(p => p.id));
    const newProfiles = backup.profiles.filter(p => !existingProfileIds.has(p.id));
    finalProfiles = [...current.profiles, ...newProfiles];

    const existingTemplateIds = new Set(current.templates.map(t => t.id));
    const newTemplates = backup.templates.filter(t => !existingTemplateIds.has(t.id));
    finalTemplates = [...current.templates, ...newTemplates];

    finalSettings = current.settings;

    if (Array.isArray(backup.shifts)) {
      const currentShifts = await loadShiftHistory();
      const existingShiftIds = new Set(currentShifts.map(s => s.id));
      const newShifts = backup.shifts.filter(s => !existingShiftIds.has(s.id));
      const mergedShifts = [...currentShifts, ...newShifts].sort((a, b) => b.startTime - a.startTime);
      await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: mergedShifts });
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: finalSettings,
    [STORAGE_KEYS.PROFILES]: finalProfiles,
    [STORAGE_KEYS.TEMPLATES]: finalTemplates
  });

  return {
    settings: finalSettings,
    profiles: finalProfiles,
    templates: finalTemplates,
    cache: current.cache
  };
}

/**
 * Load current shift state from chrome.storage.local
 */
export async function loadShiftState(): Promise<ShiftState> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.SHIFT_STATE], (result) => {
      const raw = result[STORAGE_KEYS.SHIFT_STATE];
      if (raw && typeof raw.shiftActive === 'boolean') {
        resolve({
          shiftActive: raw.shiftActive,
          shiftStartTime: typeof raw.shiftStartTime === 'number' ? raw.shiftStartTime : null,
          currentOperator: typeof raw.currentOperator === 'string' ? raw.currentOperator : 'Оператор 1',
          note: typeof raw.note === 'string' ? raw.note : undefined
        });
      } else {
        resolve({
          shiftActive: false,
          shiftStartTime: null,
          currentOperator: 'Оператор 1'
        });
      }
    });
  });
}

/**
 * Start a new shift in chrome.storage.local
 */
export async function startShift(operatorName?: string, note?: string): Promise<ShiftState> {
  const now = Date.now();
  const state = await loadState();
  const operator = (operatorName && operatorName.trim()) || state.settings.lastOperator || 'Оператор 1';

  // Update operator in settings if new
  const existingList = state.settings.operatorsList || ['Оператор 1'];
  const updatedOperators = Array.from(new Set([...existingList, operator]));
  await updateSettings({
    lastOperator: operator,
    operatorsList: updatedOperators
  });

  const newState: ShiftState = {
    shiftActive: true,
    shiftStartTime: now,
    currentOperator: operator,
    note: note || undefined
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_STATE]: newState });
  return newState;
}

/**
 * End current shift, append to shift history, and reset active shift state in chrome.storage.local
 */
export async function stopShift(note?: string): Promise<{ completedShift: CompletedShift | null; shiftState: ShiftState }> {
  const current = await loadShiftState();
  if (!current.shiftActive || !current.shiftStartTime) {
    const resetState: ShiftState = { shiftActive: false, shiftStartTime: null, currentOperator: 'Оператор 1' };
    await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_STATE]: resetState });
    return { completedShift: null, shiftState: resetState };
  }

  const endTime = Date.now();
  const duration = Math.max(0, endTime - current.shiftStartTime);
  const state = await loadState();
  const orders = state.cache.orders || [];
  const sellerSharePercent = state.settings.sellerSharePercent ?? 10.0;
  const earnings = calculateShiftEarnings(current.shiftStartTime, endTime, orders, sellerSharePercent);

  const completedShift: CompletedShift = {
    id: `shift_${current.shiftStartTime}_${Math.random().toString(36).slice(2, 8)}`,
    operatorName: current.currentOperator || state.settings.lastOperator || 'Оператор 1',
    startTime: current.shiftStartTime,
    endTime,
    duration,
    sellerSharePercent,
    earnings,
    note: note || current.note
  };

  const history = await loadShiftHistory();
  const updatedHistory = [completedShift, ...history];

  const resetState: ShiftState = {
    shiftActive: false,
    shiftStartTime: null,
    currentOperator: current.currentOperator || 'Оператор 1'
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.SHIFT_STATE]: resetState,
    [STORAGE_KEYS.SHIFT_HISTORY]: updatedHistory
  });

  return { completedShift, shiftState: resetState };
}

/**
 * Load shift history from chrome.storage.local, normalizing older legacy records
 */
export async function loadShiftHistory(): Promise<CompletedShift[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.SHIFT_HISTORY], (result) => {
      const history = result[STORAGE_KEYS.SHIFT_HISTORY];
      if (Array.isArray(history)) {
        const normalized: CompletedShift[] = history.map(s => ({
          id: s.id || `shift_${s.startTime || Date.now()}`,
          operatorName: s.operatorName || 'Оператор 1',
          startTime: s.startTime || 0,
          endTime: s.endTime || 0,
          duration: typeof s.duration === 'number' ? s.duration : Math.max(0, (s.endTime || 0) - (s.startTime || 0)),
          sellerSharePercent: typeof s.sellerSharePercent === 'number' ? s.sellerSharePercent : undefined,
          earnings: s.earnings && typeof s.earnings.ordersCount === 'number'
            ? s.earnings
            : {
                ordersCount: 0,
                turnoverByCurrency: {},
                sellerShareByCurrency: {},
                refundedCount: 0,
                refundedSumByCurrency: {},
                orderIds: []
              },
          note: s.note
        }));
        normalized.sort((a, b) => b.startTime - a.startTime);
        resolve(normalized);
      } else {
        resolve([]);
      }
    });
  });
}

/**
 * Save an edited or manually added shift into chrome.storage.local
 */
export async function saveShift(shift: CompletedShift): Promise<void> {
  const history = await loadShiftHistory();
  const idx = history.findIndex(s => s.id === shift.id);
  let updated: CompletedShift[];
  if (idx >= 0) {
    updated = [...history];
    updated[idx] = shift;
  } else {
    updated = [shift, ...history];
  }
  updated.sort((a, b) => b.startTime - a.startTime);
  await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: updated });
}

/**
 * Delete a shift by ID from chrome.storage.local
 */
export async function deleteShift(shiftId: string): Promise<void> {
  const history = await loadShiftHistory();
  const updated = history.filter(s => s.id !== shiftId);
  await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: updated });
}

/**
 * Recalculate financial earnings for all shifts in history based on orders
 */
export async function recalculateShifts(orders: FunPayOrder[], defaultSellerSharePercent: number): Promise<CompletedShift[]> {
  const history = await loadShiftHistory();
  const updated = history.map(shift => {
    const sharePercent = defaultSellerSharePercent ?? shift.sellerSharePercent ?? 10.0;
    const newEarnings = calculateShiftEarnings(shift.startTime, shift.endTime, orders, sharePercent);
    return {
      ...shift,
      sellerSharePercent: sharePercent,
      earnings: newEarnings
    };
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.SHIFT_HISTORY]: updated });
  return updated;
}
