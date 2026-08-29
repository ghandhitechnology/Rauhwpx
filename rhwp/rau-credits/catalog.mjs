/** Rau 체험 키에 허용하는 OpenRouter 모델. 허브 카탈로그와 같은 네 줄이다. */
export const RAU_MODEL_IDS = Object.freeze([
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-0731',
  'qwen/qwen3.8-flash',
  'upstage/solar-pro4',
]);

export const RAU_LOCKED_MODELS = Object.freeze([
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    reasoning: true,
    supportsImages: false,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    contextLength: 1_310_720,
    pricing: { prompt: 0, completion: 0 },
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    reasoning: true,
    supportsImages: false,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    contextLength: 1_310_720,
    pricing: { prompt: 0, completion: 0 },
  },
  {
    id: 'qwen/qwen3.8-flash',
    name: 'Qwen 3.8 Flash',
    reasoning: true,
    supportsImages: true,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    contextLength: 1_000_000,
    pricing: { prompt: 0, completion: 0 },
  },
  {
    id: 'upstage/solar-pro4',
    name: 'Solar Pro 4',
    reasoning: true,
    supportsImages: false,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    contextLength: 524_288,
    pricing: { prompt: 0, completion: 0 },
  },
]);

export const RAU_DEFAULT_MODEL_ID = RAU_LOCKED_MODELS[0].id;
export const RAU_CREDIT_LIMIT_USD = 5;
