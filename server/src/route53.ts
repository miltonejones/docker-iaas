import {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  ChangeAction,
  type HostedZone,
} from "@aws-sdk/client-route-53";

let _client: Route53Client | null = null;
let _clientError: string | null = null;

function getClient(): Route53Client | null {
  if (_client) return _client;
  if (_clientError) return null;
  try {
    _client = new Route53Client({
      region: process.env.AWS_REGION || "us-east-1",
      maxAttempts: 2,
    });
    return _client;
  } catch (err) {
    _clientError = (err as Error).message;
    return null;
  }
}

// ── Preflight ──────────────────────────────────────────────────────────────

export interface HostedZoneInfo {
  id: string;
  name: string;  // normalized, trailing dot, e.g. "ktunes.app."
  isPrivate: boolean;
}

export interface PreflightResult {
  available: boolean;
  error?: string;
  zones: HostedZoneInfo[];
  matchedZone?: HostedZoneInfo;  // the best match for the domain, if any
  isApex: boolean;               // domain equals a zone name exactly
}

/** Read-only capability probe.  Lists hosted zones and finds the best
 *  match for the given domain.  Never writes — safe to call at any time. */
export async function route53Preflight(domain: string): Promise<PreflightResult> {
  const client = getClient();
  if (!client) {
    return { available: false, error: _clientError || "Route 53 client unavailable", zones: [], isApex: false };
  }

  let zones: HostedZoneInfo[] = [];
  try {
    const res = await client.send(new ListHostedZonesCommand({}));
    zones = (res.HostedZones || []).map((z: HostedZone) => ({
      id: z.Id?.replace("/hostedzone/", "") || "",
      name: z.Name || "",
      isPrivate: z.Config?.PrivateZone || false,
    }));
  } catch (err) {
    return { available: false, error: (err as Error).message, zones: [], isApex: false };
  }

  const matchedZone = findHostedZoneForDomain(domain, zones);
  const normalizedDomain = domain.endsWith(".") ? domain : domain + ".";
  const isApex = zones.some((z) => z.name === normalizedDomain);

  return { available: true, zones, matchedZone, isApex };
}

/** Longest-suffix match of a domain against hosted zone names.
 *  e.g. for "start.ktunes.app" matches zone "ktunes.app." over "app."
 *  Returns undefined if no zone matches.  Only matches public zones. */
export function findHostedZoneForDomain(
  domain: string,
  zones: HostedZoneInfo[],
): HostedZoneInfo | undefined {
  const normalized = domain.endsWith(".") ? domain : domain + ".";

  let best: HostedZoneInfo | undefined;
  let bestLen = 0;

  for (const z of zones) {
    if (z.isPrivate) continue;
    const zoneName = z.name.endsWith(".") ? z.name : z.name + ".";
    if (normalized.endsWith("." + zoneName) || normalized === zoneName) {
      if (zoneName.length > bestLen) {
        bestLen = zoneName.length;
        best = z;
      }
    }
  }

  return best;
}

// ── DNS record operations ──────────────────────────────────────────────────

const EDGE_HOST = process.env.DOCKYARD_EDGE_HOST || "dockyard-ai.com";

/** UPSERT a CNAME record in the given hosted zone.  Returns the change ID
 *  for polling propagation. */
export async function upsertCname(
  zoneId: string,
  recordName: string,
  ttl = 300,
): Promise<{ changeId: string }> {
  const client = getClient();
  if (!client) throw new Error("Route 53 client unavailable");

  const res = await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT" as ChangeAction,
            ResourceRecordSet: {
              Name: recordName.endsWith(".") ? recordName : recordName + ".",
              Type: "CNAME",
              TTL: ttl,
              ResourceRecords: [{ Value: EDGE_HOST }],
            },
          },
        ],
      },
    }),
  );

  return { changeId: res.ChangeInfo?.Id || "" };
}

/** DELETE a CNAME record Dockyard previously created.  Must match the exact
 *  name, type, and value.  Best-effort — tolerates "record not found." */
export async function deleteCname(
  zoneId: string,
  recordName: string,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Route 53 client unavailable");

  try {
    await client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: "DELETE" as ChangeAction,
              ResourceRecordSet: {
                Name: recordName.endsWith(".") ? recordName : recordName + ".",
                Type: "CNAME",
                TTL: 300,
                ResourceRecords: [{ Value: EDGE_HOST }],
              },
            },
          ],
        },
      }),
    );
  } catch (err) {
    // Tolerate "not found" or "no such record" — best-effort cleanup.
    const msg = (err as Error).message || "";
    if (!msg.includes("not found") && !msg.includes("but it was not found")) {
      throw err;
    }
  }
}

/** For unit tests — inject a mock client.  Pass null to reset to real. */
export function _setClientForTest(client: Route53Client | null): void {
  _client = client;
  _clientError = null;
}
