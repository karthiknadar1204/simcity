const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export const worldUrl = (path: string) => `${base}/api/world${path}`;

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(worldUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body as T;
}
