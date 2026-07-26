import { docker } from '../docker.js';

export async function list() {
  const data: any = await new Promise((resolve, reject) => {
    (docker as any).modem.dial(
      { method: 'GET', path: '/system/df', statusCodes: { 200: true } },
      (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
    );
  });
  return (data?.Volumes || []).map((v: any) => ({
    name: v.Name || '',
    driver: v.Driver || '',
    mountpoint: v.Mountpoint || '',
    createdAt: v.CreatedAt || '',
    size: v.UsageData?.Size || 0,
    refCount: v.UsageData?.RefCount || 0,
  }));
}
