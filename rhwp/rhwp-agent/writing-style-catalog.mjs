import { StyleCalibrationError } from './style-calibrator.mjs';

const CODEX_MODELS = Object.freeze([
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
]);

const CLAUDE_MODELS = Object.freeze([
  { id: 'opus', name: 'Claude Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'fable', name: 'Claude Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'sonnet', name: 'Claude Sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'haiku', name: 'Claude Haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
]);

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
function providerAvailable(id, health, piStatus, rauStatus) {
  if (id === 'pi') return Boolean(piStatus?.setupComplete);
  if (id === 'rau') return Boolean(rauStatus?.setupComplete);
  return health?.[id]?.available !== false;
}

export function buildWritingStyleCatalog({
  health = null, piStatus = null, rauStatus = null, currentSelection = null,
} = {}) {
  const providers = [
    {
      id: 'codex', name: 'Codex', available: providerAvailable('codex', health, piStatus, rauStatus),
      error: health?.codex?.error ?? null, models: CODEX_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
    },
    {
      id: 'claude', name: 'Claude', available: providerAvailable('claude', health, piStatus, rauStatus),
      error: health?.claude?.error ?? null, models: CLAUDE_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })),
    },
    {
      id: 'rau', name: 'Rau', available: providerAvailable('rau', health, piStatus, rauStatus),
      error: rauStatus?.setupComplete ? null : 'Connect Rau to use trial credits.',
      models: piModels(rauStatus),
    },
    {
      id: 'pi', name: 'Pi · OpenRouter', available: providerAvailable('pi', health, piStatus, rauStatus),
      error: piStatus?.setupComplete ? null : 'Configure an OpenRouter key and at least one Pi model.',
      models: piModels(piStatus),
    },
  ];
  let selection = null;
  if (currentSelection?.agent && currentSelection?.model) {
    const provider = providers.find((entry) => entry.id === currentSelection.agent && entry.available);
    const model = provider?.models.find((entry) => entry.id === currentSelection.model);
    if (provider && model) selection = { agent: provider.id, model: model.id, effort: currentSelection.effort ?? model.defaultEffort };
  }
  if (!selection) {
    const preferred = providers.find((entry) => entry.available && entry.models.length > 0);
    const model = preferred?.id === 'pi'
      ? preferred.models.find((entry) => entry.id === piStatus?.defaultModelId) ?? preferred.models[0]
      : preferred?.models.find((entry) => entry.id === (preferred.id === 'codex' ? 'gpt-5.6-terra' : 'sonnet')) ?? preferred?.models[0];
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
  const modelId = explicitModel ? String(request.model) : (catalog.defaultSelection?.agent === agent ? catalog.defaultSelection.model : null);
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
