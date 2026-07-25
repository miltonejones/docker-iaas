import {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  ChangeAction,
  type HostedZone,
} from "@aws-sdk/client-route-53";
import { resolveCname } from "node:dns/promises";
import fs from "node:fs";

let _client: Route53Client | null = null;
let _clientError: string | null = null;

/** Read an AWS credential — env var first, then a Docker secret file at
 *  /run/secrets/.  Follows the same pattern as readMasterSecret() in
 *  databaseManagement.ts and resolveGithubToken() in githubAssistantTools.ts. */
function readAwsSecret(envName: string, secretFileName: string): string | undefined {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  const secretFile =
    process.env[`${envName}_FILE`] || `/run/secrets/${secretFileName}`;
  try {
    const fileSecret = fs.readFileSync(secretFile, "utf8").trim();
    return fileSecret || undefined;
  } catch {
    return undefined;
  }
}

function getClient(): Route53Client | null {
  if (_client) return _client;
  if (_clientError) return null;
  try {
    const accessKeyId = readAwsSecret("AWS_ACCESS_KEY_ID", "aws_access_key_id");
    const secretAccessKey = readAwsSecret(
      "AWS_SECRET_ACCESS_KEY",
      "aws_secret_access_key",
    );

    _client = new Route53Client({
      region: process.env.AWS_REGION || "us-east-1",
      maxAttempts: 2,
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
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
  name: string;
  isPrivate: boolean;
}

export interface PreflightResult {
  available: boolean;
  error?: string;
  zones: HostedZoneInfo[];
  matchedZone?: HostedZoneInfo;
  isApex: boolean;
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

  // isApex: domain equals a PUBLIC zone name exactly (consistent with findHostedZoneForDomain's public-only filter)
  const isApex = zones.some((z) => !z.isPrivate && z.name === normalizedDomain);

  return { available: true, zones, matchedZone, isApex };
}

/** Longest-suffix match of a domain against hosted zone names.
 *  e.g. "start.ktunes.app" matches zone "ktunes.app." over "app."
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
const CNAME_TTL = 300;

/** Check if a domain resolves to a CNAME pointing at the Dockyard edge. */
export async function domainResolves(domain: string): Promise<boolean> {
  try {
    const results = await resolveCname(domain);
    return results.some((r) => r === EDGE_HOST || r === EDGE_HOST + ".");
  } catch {
    return false;
  }
}

export interface ExistingRecord {
  name: string;
  type: string;
  values: string[];
}

/** List records for a given name + type in a hosted zone.  Empty array if
 *  no matching records exist. */
export async function listExistingRecords(
  zoneId: string,
  recordName: string,
): Promise<ExistingRecord[]> {
  const client = getClient();
  if (!client) throw new Error("Route 53 client unavailable");

  const fullName = recordName.endsWith(".") ? recordName : recordName + ".";
  const res = await client.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      StartRecordName: fullName,
      MaxItems: 20,
    }),
  );

  return (res.ResourceRecordSets || [])
    .filter((r) => r.Name === fullName)
    .map((r) => ({
      name: r.Name || "",
      type: r.Type || "",
      values: (r.ResourceRecords || []).map((v) => v.Value || ""),
    }));
}

/** UPSERT a CNAME record in the given hosted zone.  Without `overwrite`,
 *  throws if any record already exists at this name. */
export async function upsertCname(
  zoneId: string,
  recordName: string,
  overwrite = false,
): Promise<{ changeId: string }> {
  const client = getClient();
  if (!client) throw new Error("Route 53 client unavailable");

  if (!overwrite) {
    const existing = await listExistingRecords(zoneId, recordName);
    if (existing.length > 0) {
      const detail = existing.map((r) => `${r.type} → ${r.values.join(", ")}`).join("; ");
      throw new Error(
        `Record "${recordName}" already exists (${detail}). Remove it first or set overwrite: true.`,
      );
    }
  }

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
              TTL: CNAME_TTL,
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
                TTL: CNAME_TTL,
                ResourceRecords: [{ Value: EDGE_HOST }],
              },
            },
          ],
        },
      }),
    );
  } catch (err) {
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
