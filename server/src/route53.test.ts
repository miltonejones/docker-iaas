import test from "node:test";
import assert from "node:assert/strict";
import { Route53Client } from "@aws-sdk/client-route-53";
import {
  findHostedZoneForDomain,
  _setClientForTest,
  upsertCname,
  deleteCname,
  listExistingRecords,
  type HostedZoneInfo,
} from "./route53.js";

// ── findHostedZoneForDomain ───────────────────────────────────────────────

function z(id: string, name: string, isPrivate = false): HostedZoneInfo {
  return { id, name: name.endsWith(".") ? name : name + ".", isPrivate };
}

test("findHostedZoneForDomain: exact match", () => {
  const zones = [z("Z1", "ktunes.app."), z("Z2", "example.com.")];
  const result = findHostedZoneForDomain("start.ktunes.app", zones);
  assert.ok(result);
  assert.equal(result!.id, "Z1");
});

test("findHostedZoneForDomain: longest suffix wins", () => {
  const zones = [
    z("Z1", "app."),
    z("Z2", "ktunes.app."),
    z("Z3", "example.com."),
  ];
  const result = findHostedZoneForDomain("start.ktunes.app", zones);
  assert.ok(result);
  assert.equal(result!.id, "Z2");
});

test("findHostedZoneForDomain: trailing dot on input handled", () => {
  const zones = [z("Z1", "ktunes.app.")];
  const result = findHostedZoneForDomain("start.ktunes.app.", zones);
  assert.ok(result);
  assert.equal(result!.id, "Z1");
});

test("findHostedZoneForDomain: no match", () => {
  const zones = [z("Z1", "ktunes.app."), z("Z2", "dockyard.ai.")];
  const result = findHostedZoneForDomain("start.github.io", zones);
  assert.equal(result, undefined);
});

test("findHostedZoneForDomain: skips private zones", () => {
  const zones = [z("Z1", "ktunes.app.", true), z("Z2", "example.com.")];
  const result = findHostedZoneForDomain("start.ktunes.app", zones);
  assert.equal(result, undefined); // private zone should be skipped
});

test("findHostedZoneForDomain: partial suffix not matched", () => {
  const zones = [z("Z1", "tunes.app.")];
  const result = findHostedZoneForDomain("start.ktunes.app", zones);
  assert.equal(result, undefined); // "tunes.app" ≠ suffix of "ktunes.app"
});

test("findHostedZoneForDomain: apex exact match", () => {
  const zones = [z("Z1", "ktunes.app.")];
  const result = findHostedZoneForDomain("ktunes.app", zones);
  assert.ok(result);
  assert.equal(result!.id, "Z1");
});

// ── Clean up test client injection ────────────────────────────────────────
test("_setClientForTest cleanup", () => {
  _setClientForTest(null);
  assert.ok(true); // ensure cleanup runs
});

// ── Mock-client tests ─────────────────────────────────────────────────────

/** Creates a mock Route53Client whose send() returns canned responses. */
function mock53(handlers: Record<string, () => unknown>): typeof Route53Client.prototype {
  return {
    send: async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const h = handlers[name];
      if (!h) throw new Error(`No mock for ${name}`);
      return await h();
    },
  } as unknown as typeof Route53Client.prototype;
}

test("upsertCname: without overwrite, throws when record exists", async () => {
  _setClientForTest(mock53({
    ListResourceRecordSetsCommand: () => ({
      ResourceRecordSets: [
        { Name: "start.ktunes.app.", Type: "CNAME", ResourceRecords: [{ Value: "old.com." }] },
      ],
    }),
  }));
  try {
    await upsertCname("Z1", "start.ktunes.app");
    assert.fail("Expected throw");
  } catch (err) {
    assert.match((err as Error).message, /already exists/);
  }
  _setClientForTest(null);
});

test("upsertCname: with overwrite, succeeds when record exists", async () => {
  let sent = false;
  _setClientForTest(mock53({
    ListResourceRecordSetsCommand: () => ({
      ResourceRecordSets: [
        { Name: "start.ktunes.app.", Type: "A", ResourceRecords: [{ Value: "1.2.3.4" }] },
      ],
    }),
    ChangeResourceRecordSetsCommand: () => { sent = true; return { ChangeInfo: { Id: "ch-1" } }; },
  }));
  const r = await upsertCname("Z1", "start.ktunes.app", true);
  assert.equal(r.changeId, "ch-1");
  assert.ok(sent);
  _setClientForTest(null);
});

test("upsertCname: clean name succeeds", async () => {
  _setClientForTest(mock53({
    ListResourceRecordSetsCommand: () => ({ ResourceRecordSets: [] }),
    ChangeResourceRecordSetsCommand: () => ({ ChangeInfo: { Id: "ch-2" } }),
  }));
  const r = await upsertCname("Z1", "new.ktunes.app");
  assert.equal(r.changeId, "ch-2");
  _setClientForTest(null);
});

test("deleteCname: tolerates not-found", async () => {
  _setClientForTest(mock53({
    ChangeResourceRecordSetsCommand: () => { throw new Error("but it was not found"); },
  }));
  await deleteCname("Z1", "x.ktunes.app");
  _setClientForTest(null);
});

test("deleteCname: propagates unexpected errors", async () => {
  _setClientForTest(mock53({
    ChangeResourceRecordSetsCommand: () => { throw new Error("AccessDenied"); },
  }));
  try {
    await deleteCname("Z1", "x.ktunes.app");
    assert.fail("Expected throw");
  } catch (err) {
    assert.match((err as Error).message, /AccessDenied/);
  }
  _setClientForTest(null);
});

test("listExistingRecords: filters exact name, all types", async () => {
  _setClientForTest(mock53({
    ListResourceRecordSetsCommand: () => ({
      ResourceRecordSets: [
        { Name: "start.ktunes.app.", Type: "CNAME", ResourceRecords: [{ Value: "other.com." }] },
        { Name: "www.ktunes.app.", Type: "A", ResourceRecords: [{ Value: "1.2.3.4" }] },
      ],
    }),
  }));
  const records = await listExistingRecords("Z1", "start.ktunes.app");
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "CNAME");
  // Confirm the A record was not returned (wrong name)
  assert.equal(records[0].values[0], "other.com.");
  _setClientForTest(null);
});

