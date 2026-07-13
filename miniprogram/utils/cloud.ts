export async function callApi<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  const result = await wx.cloud.callFunction({ name: "api", data: { action, payload } });
  const body = result.result as any;
  if (!body?.ok) throw new Error(body?.error?.message || "云服务请求失败");
  return body.data as T;
}

export function formatDuration(seconds = 0) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

export function formatDate(value: string | number | Date) {
  const d = new Date(value);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
