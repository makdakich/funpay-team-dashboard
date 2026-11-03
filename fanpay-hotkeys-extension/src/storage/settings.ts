import { AppSettings } from '../shared/types';
import { loadState, updateSettings } from './storage';

export async function getSettings(): Promise<AppSettings> {
  const state = await loadState();
  return state.settings;
}

export async function setSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  return await updateSettings(partial);
}

export async function setSelectedProfile(profileId: string): Promise<AppSettings> {
  return await updateSettings({ selectedProfileId: profileId });
}
