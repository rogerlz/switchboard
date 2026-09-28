interface CloudProviderOption {
  id: string;
  models?: ReadonlyArray<{ id: string }>;
}

export function reconcileCloudProviderSelection({
  selectedProvider,
  selectedModel,
  allowedProviders,
  customAllowed,
  hasCustomUrl,
}: {
  selectedProvider: string;
  selectedModel: string;
  allowedProviders: readonly CloudProviderOption[];
  customAllowed: boolean;
  hasCustomUrl: boolean;
}): { provider: string; model: string } | null {
  if (selectedProvider === "custom" && customAllowed) return null;
  const selected = allowedProviders.find((provider) => provider.id === selectedProvider);
  if (selected) {
    if (!selected.models?.length || selected.models.some((model) => model.id === selectedModel)) {
      return null;
    }
    return { provider: selected.id, model: selected.models[0].id };
  }
  if (hasCustomUrl && customAllowed) {
    return { provider: "custom", model: selectedModel || "whisper-1" };
  }
  const first = allowedProviders[0];
  if (!first) {
    return customAllowed ? { provider: "custom", model: selectedModel || "whisper-1" } : null;
  }
  return { provider: first.id, model: first.models?.[0]?.id ?? "" };
}
