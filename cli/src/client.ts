export interface DockyardClientConfig {
  apiUrl: string;
  apiKey: string;
}

export async function request<T>(
  config: DockyardClientConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}
