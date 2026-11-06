// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

export interface SpaceModelOption {
  value: string;
  label: string;
  reasoningEfforts?: ReasoningEffort[];
}

/**
 * Name of the Project.setting entry that holds the list of selectable AI models.
 * The value should be a JSON-encoded array of {@link SpaceModelOption} objects, e.g.
 * `[{"value":"gpt-5.5","label":"GPT-5.5"},{"value":"my-litellm-model","label":"Custom"}]`.
 * Manage it from the project admin "Settings" page.
 */
export const AI_MODELS_SETTING = 'aiModels';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  label: string;
}

/**
 * Reasoning effort levels selectable next to the model.
 * The value is passed to the AI bots as the `reasoning_effort` input parameter.
 */
export const REASONING_EFFORTS: ReasoningEffortOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

/** Reasoning effort preselected for a new conversation. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

/** Built-in fallback used when the project has not configured `aiModels`. */
export const DEFAULT_MODELS: SpaceModelOption[] = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
];

/**
 * Reads the selectable AI model list from the current project's settings.
 * Falls back to {@link DEFAULT_MODELS} when the setting is missing, empty, or malformed.
 * @param medplum - The Medplum client.
 * @returns The list of model options to show in the model picker.
 */
export function getProjectModels(medplum: MedplumClient): SpaceModelOption[] {
  const valueString = medplum.getProject()?.setting?.find((s) => s.name === AI_MODELS_SETTING)?.valueString;
  if (valueString) {
    try {
      const parsed = JSON.parse(valueString);
      if (Array.isArray(parsed)) {
        const models = parsed
          .filter(
            (m): m is { value: string; label?: unknown; reasoningEfforts?: unknown } =>
              Boolean(m) && typeof m.value === 'string' && m.value.length > 0
          )
          .map((m) => {
            const reasoningEfforts = REASONING_EFFORTS.filter(
              (effort) => Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.includes(effort.value)
            ).map((effort) => effort.value);
            return {
              value: m.value,
              label: typeof m.label === 'string' && m.label ? m.label : m.value,
              ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
            };
          });
        if (models.length > 0) {
          return models;
        }
      }
    } catch {
      // Ignore malformed JSON and fall back to defaults.
    }
  }
  return DEFAULT_MODELS;
}

/**
 * Restricts the reasoning menu through the existing aiModels setting.
 * @param model - The selected model and its configured capabilities.
 * @returns The supported reasoning options, or the legacy defaults.
 */
export function getModelReasoningEfforts(model: SpaceModelOption | undefined): ReasoningEffortOption[] {
  return model?.reasoningEfforts
    ? REASONING_EFFORTS.filter((effort) => model.reasoningEfforts?.includes(effort.value))
    : REASONING_EFFORTS;
}

/**
 * Returns the default model value to preselect — the first entry in the list.
 * @param models - The available model options.
 * @returns The default model value.
 */
export function getDefaultModel(models: SpaceModelOption[]): string {
  return models[0]?.value ?? DEFAULT_MODELS[0].value;
}
