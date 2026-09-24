import { StyleCalibrationError } from './style-calibrator.mjs';

const CODEX_MODELS = Object.freeze([
  { id: 'astra', name: 'Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'luna', name: 'Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'terra', name: 'Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
]);

const CLAUDE_MODELS = Object.freeze([
  { id: 'fable', name: 'Claude Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'opus', name: 'Claude Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'sonnet', name: 'Claude Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'haiku', name: 'Claude Haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
]);

function currentLineup(agent, model) {
  if (agent === 'codex') return /^gpt-\d+(?:\.\d+)*-(astra|sol|luna|terra)$/.exec(model)?.[1] ?? model;
  if (agent === 'claude') return /^claude-(fable|opus|sonnet|haiku)-\d+(?:[-.]\d+)*$/.exec(model)?.[1] ?? model;
  return model;
}

function piModels(piStatus) {
  return (Array.isArray(piStatus?.models) ? piStatus.models : []).map((model) => ({
    id: String(model.id),
    name: String(model.name || model.id),
    efforts: Array.isArray(model.efforts) ? model.efforts.map(String) : [],
    defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : null,
    contextLength: Number.isFinite(model.contextLength) ? model.contextLength : null,
    pricing: model.pricing && typeof model.pricing === 'object' ? { ...model.pricing } : null,
  }));
}
function providerAvailable(id, health, piStatus) {
  if (id === 'pi') return Boolean(piStatus?.setupComplete);
  return health?.[id]?.available !== false;
}

export function buildWritingStyleCatalog({
  health = null, piStatus = null, currentSelection = null,
} = {}) {
  const providers = [
    {
      id: 'codex', name: 'Codex', available: providerAvailable('codex', health, piStatus),
      error: health?.codex?.error ?? null, models: CODEX_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
    },
    {
      id: 'claude', name: 'Claude', available: providerAvailable('claude', health, piStatus),
      error: health?.claude?.error ?? null, models: CLAUDE_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
    },
    {
      id: 'pi', name: 'Pi · OpenRouter', available: providerAvailable('pi', health, piStatus),
      error: piStatus?.setupComplete ? null : 'Configure an OpenRouter key and at least one Pi model.',
      models: piModels(piStatus),
    },
  ];
  let selection = null;
  if (currentSelection?.agent && currentSelection?.model) {
    const provider = providers.find((entry) => entry.id === currentSelection.agent && entry.available);
    const model = provider?.models.find((entry) => entry.id === currentLineup(provider.id, currentSelection.model));
    if (provider && model) selection = { agent: provider.id, model: model.id, effort: currentSelection.effort ?? model.defaultEffort };
  }
  if (!selection) {
    const preferred = providers.find((entry) => entry.available && entry.models.length > 0);
    const model = preferred?.id === 'pi'
      ? preferred.models.find((entry) => entry.id === piStatus?.defaultModelId) ?? preferred.models[0]
      : preferred?.models.find((entry) => entry.id === (preferred.id === 'codex' ? 'terra' : 'sonnet')) ?? preferred?.models[0];
    if (preferred && model) selection = { agent: preferred.id, model: model.id, effort: model.defaultEffort };
  }
  return { providers, defaultSelection: selection };
}

/** Resolve only values present in the catalog. Explicit stale/unknown values never fall back silently. */
export function resolveWritingStyleSelection(request, options = {}) {
  const catalog = buildWritingStyleCatalog(options);
  const explicitAgent = request?.agent !== undefined && request?.agent !== null && request.agent !== '';
  const explicitModel = request?.model !== undefined && request?.model !== null && request.model !== '';
  const agent = explicitAgent ? String(request.agent) : catalog.defaultSelection?.agent;
  const provider = catalog.providers.find((entry) => entry.id === agent);
  if (!provider) throw new StyleCalibrationError('PROVIDER_UNAVAILABLE', `Unknown calibration provider: ${agent || '(none)'}.`);
  if (!provider.available) throw new StyleCalibrationError('PROVIDER_UNAVAILABLE', provider.error || `${provider.name} is unavailable.`);
  const modelId = explicitModel ? currentLineup(agent, String(request.model)) : (catalog.defaultSelection?.agent === agent ? catalog.defaultSelection.model : null);
  const model = provider.models.find((entry) => entry.id === modelId);
  if (!model) throw new StyleCalibrationError('MODEL_UNAVAILABLE', `The selected ${provider.name} model is unavailable: ${modelId || '(none)'}.`);
  const requestedEffort = typeof request?.effort === 'string' && request.effort ? request.effort : null;
  if (requestedEffort && !model.efforts.includes(requestedEffort)) {
    throw new StyleCalibrationError('EFFORT_UNAVAILABLE', `${model.name} does not support ${requestedEffort} reasoning effort.`);
  }
  return {
    agent: provider.id,
    model: model.id,
    effort: requestedEffort ?? model.defaultEffort ?? null,
  };
}
