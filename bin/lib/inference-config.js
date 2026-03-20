// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const INFERENCE_ROUTE_URL = "https://inference.local/v1";
const DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const CLOUD_MODEL_OPTIONS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
  { id: "z-ai/glm5", label: "GLM-5" },
  { id: "minimaxai/minimax-m2.5", label: "MiniMax M2.5" },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B A17B" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];

const CLOUD_PROVIDERS = {
  cloud: {
    key: "cloud",
    label: "NVIDIA Cloud API (build.nvidia.com)",
    providerName: "nvidia-nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialKey: "NVIDIA_API_KEY",
    credentialPrompt: "Enter your NVIDIA API key",
    credentialHint: "Get one from https://build.nvidia.com",
    policyFile: null, // NVIDIA egress is handled by the base sandbox policy
    models: CLOUD_MODEL_OPTIONS,
  },
  gemini: {
    key: "gemini",
    label: "Google AI Studio (Gemini)",
    providerName: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialKey: "GEMINI_API_KEY",
    credentialPrompt: "Enter your Google AI Studio API key",
    credentialHint: "Get one from https://aistudio.google.com",
    policyFile: "gemini-egress.yaml",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
};
const DEFAULT_ROUTE_PROFILE = "inference-local";
const DEFAULT_ROUTE_CREDENTIAL_ENV = "OPENAI_API_KEY";
const MANAGED_PROVIDER_ID = "inference";
const { DEFAULT_OLLAMA_MODEL } = require("./local-inference");

function getProviderSelectionConfig(provider, model) {
  switch (provider) {
    case "nvidia-nim":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_CLOUD_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "NVIDIA Cloud API",
      };
    case "vllm-local":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "vllm-local",
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "Local vLLM",
      };
    case "ollama-local":
      return {
        endpointType: "custom",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_OLLAMA_MODEL,
        profile: DEFAULT_ROUTE_PROFILE,
        credentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        provider,
        providerLabel: "Local Ollama",
      };
    default: {
      // Check cloud providers registry for a match by providerName
      const cloudEntry = Object.values(CLOUD_PROVIDERS).find(
        (cp) => cp.providerName === provider
      );
      if (cloudEntry) {
        return {
          endpointType: "custom",
          endpointUrl: cloudEntry.baseUrl,
          ncpPartner: null,
          model: model || cloudEntry.models[0].id,
          profile: DEFAULT_ROUTE_PROFILE,
          credentialEnv: cloudEntry.credentialKey,
          provider,
          providerLabel: cloudEntry.label,
        };
      }
      return null;
    }
  }
}

function getOpenClawPrimaryModel(provider, model) {
  let resolvedModel = model;
  if (!resolvedModel) {
    if (provider === "ollama-local") {
      resolvedModel = DEFAULT_OLLAMA_MODEL;
    } else {
      // Look up default model from cloud provider registry
      const cloudEntry = Object.values(CLOUD_PROVIDERS).find(
        (cp) => cp.providerName === provider
      );
      resolvedModel = cloudEntry ? cloudEntry.models[0].id : DEFAULT_CLOUD_MODEL;
    }
  }
  return resolvedModel ? `${MANAGED_PROVIDER_ID}/${resolvedModel}` : null;
}

module.exports = {
  CLOUD_MODEL_OPTIONS,
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ROUTE_CREDENTIAL_ENV,
  DEFAULT_ROUTE_PROFILE,
  INFERENCE_ROUTE_URL,
  MANAGED_PROVIDER_ID,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
};
