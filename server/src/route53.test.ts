import test from "node:test";
import assert from "node:assert/strict";
import { Route53Client } from "@aws-sdk/client-route-53";
import {
  findHostedZoneForDomain,
  _setClientForTest,
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
