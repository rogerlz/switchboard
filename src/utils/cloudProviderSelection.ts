interface CloudProviderOption {
  id: string;
  models?: ReadonlyArray<{ id: string }>;
}

export function reconcileCloudProviderSelection({
  selectedProvider,
  selectedModel,
  allowedProviders,
}: {
  selectedProvider: string;
  selectedModel: string;
  allowedProviders: readonly CloudProviderOption[];
}): { provider: string; model: string } | null {
  const selected = allowedProviders.find((provider) => provider.id === selectedProvider);
  if (selected) {
    if (!selected.models?.length || selected.models.some((model) => model.id === selectedModel)) {
      return null;
    }
    return { provider: selected.id, model: selected.models[0].id };
  }
  const first = allowedProviders[0];
  if (!first) return null;
  return { provider: first.id, model: first.models?.[0]?.id ?? "" };
}
