import { Profile, Template } from '../shared/types';
import { loadState, saveProfiles, saveTemplates } from './storage';
import { COMMON_PROFILE_ID } from '../shared/constants';

/**
 * Get all profiles
 */
export async function getProfiles(): Promise<Profile[]> {
  const state = await loadState();
  return state.profiles;
}

/**
 * Add or update a profile
 */
export async function upsertProfile(profile: Profile): Promise<Profile[]> {
  const state = await loadState();
  const index = state.profiles.findIndex(p => p.id === profile.id);
  let updated: Profile[];

  if (index >= 0) {
    updated = [...state.profiles];
    updated[index] = profile;
  } else {
    updated = [...state.profiles, profile];
  }

  await saveProfiles(updated);
  return updated;
}

/**
 * Delete a profile and its templates (unless it's the common profile)
 */
export async function deleteProfile(profileId: string): Promise<{ profiles: Profile[]; templates: Template[] }> {
  if (profileId === COMMON_PROFILE_ID) {
    throw new Error('Профиль "Общий" нельзя удалить.');
  }

  const state = await loadState();
  const profiles = state.profiles.filter(p => p.id !== profileId);
  const templates = state.templates.filter(t => t.profileId !== profileId);

  await saveProfiles(profiles);
  await saveTemplates(templates);

  return { profiles, templates };
}

/**
 * Get templates for a specific profile, including "Общий" templates
 */
export async function getTemplatesForProfile(profileId: string): Promise<Template[]> {
  const state = await loadState();
  return state.templates.filter(
    t => t.enabled && (t.profileId === profileId || t.profileId === COMMON_PROFILE_ID)
  ).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Add or update template
 */
export async function upsertTemplate(template: Template): Promise<Template[]> {
  const state = await loadState();
  const index = state.templates.findIndex(t => t.id === template.id);
  let updated: Template[];

  if (index >= 0) {
    updated = [...state.templates];
    updated[index] = template;
  } else {
    updated = [...state.templates, template];
  }

  await saveTemplates(updated);
  return updated;
}

/**
 * Delete template
 */
export async function deleteTemplate(templateId: string): Promise<Template[]> {
  const state = await loadState();
  const updated = state.templates.filter(t => t.id !== templateId);
  await saveTemplates(updated);
  return updated;
}
