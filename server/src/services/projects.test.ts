import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb, createUser, createProject, createFunction, updateFunction, deleteFunction,
} from '../db.js';
import { createRoute as createRouteRow } from '../db/gateway.js';
import * as projectService from './projects.js';
import { HttpError } from './HttpError.js';

// ---------------------------------------------------------------------------
// In-memory DB. Container/bucket sections of the manifest touch the real
// Docker/MinIO clients (read-only listing filtered by a project id no real
// resource will ever match), matching the pattern already used in list().
// ---------------------------------------------------------------------------

describe('projects service — manifest & protection (in-memory)', () => {
  let userId: string;
  let projectId: string;
  let functionId: string;
  let routeId: string;

  before(() => {
    initDb(':memory:');
    const user = createUser('owner@dockyard.test', 'hash');
    userId = user.id;
    const project = createProject('Test Project', '', userId);
    projectId = project.id;
    const fn = createFunction('fn-test-1', 'my-function', 'node20', 'export default () => {}', '', null, userId, projectId);
    functionId = fn.id;
    const route = createRouteRow('rt-test-1', 'my-route', 'lambda', functionId, null, 'GET', '/hello', userId, null, projectId);
    routeId = route.id;
  });

  it('captureManifest snapshots linked functions and routes', async () => {
    const manifest = await projectService.captureManifest(projectId, userId);
    assert.equal(manifest.version, 1);
    assert.ok(manifest.capturedAt);
    assert.deepEqual(Object.keys(manifest.containers), []);
    assert.deepEqual(Object.keys(manifest.buckets), []);
    assert.deepEqual(Object.keys(manifest.databases), []);

    const fnRefs = Object.entries(manifest.functions);
    assert.equal(fnRefs.length, 1);
    const [fnRef, fnSnap] = fnRefs[0];
    assert.equal(fnRef, 'my-function');
    assert.equal(fnSnap.id, functionId);
    assert.equal(fnSnap.runtime, 'node20');

    const routeRefs = Object.entries(manifest.routes);
    assert.equal(routeRefs.length, 1);
    const [routeRef, routeSnap] = routeRefs[0];
    assert.equal(routeRef, 'my-route');
    assert.equal(routeSnap.id, routeId);
    assert.equal(routeSnap.targetType, 'lambda');
    assert.equal(routeSnap.targetRef, functionId);
  });

  it('getManifest returns the stored snapshot', () => {
    const manifest = projectService.getManifest(projectId, userId);
    assert.equal(Object.keys(manifest.functions).length, 1);
  });

  it('getManifest throws 404 for a project with no captured manifest', () => {
    const other = createProject('Other Project', '', userId);
    assert.throws(
      () => projectService.getManifest(other.id, userId),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  it('isResourceProtected reports true for a manifested function', () => {
    const check = projectService.isResourceProtected('functions', functionId);
    assert.equal(check.protected, true);
    assert.equal(check.projectName, 'Test Project');
  });

  it('isResourceProtected reports false for an unrelated id', () => {
    const check = projectService.isResourceProtected('functions', 'fn-does-not-exist');
    assert.equal(check.protected, false);
  });

  it('assertNotProtected throws 409 for non-admin, passes through for admin', () => {
    assert.throws(
      () => projectService.assertNotProtected('functions', functionId, 'operator'),
      (err: unknown) => err instanceof HttpError && err.status === 409 && /Test Project/.test(err.message),
    );
    assert.doesNotThrow(() => projectService.assertNotProtected('functions', functionId, 'admin'));
  });

  it('getManifestDrift reports synced when nothing has changed', async () => {
    const drift = await projectService.getManifestDrift(projectId, userId);
    assert.ok(drift.synced.includes('my-function'));
    assert.ok(drift.synced.includes('my-route'));
    assert.deepEqual(drift.missing, []);
    assert.deepEqual(drift.changed, []);
    assert.deepEqual(drift.orphaned, []);
  });

  it('getManifestDrift reports changed when live config diverges', async () => {
    updateFunction(functionId, { runtime: 'node22' });
    const drift = await projectService.getManifestDrift(projectId, userId);
    const change = drift.changed.find((c) => c.kind === 'functions' && c.ref === 'my-function');
    assert.ok(change);
    assert.deepEqual(change!.diff.runtime, { was: 'node20', now: 'node22' });
  });

  it('getManifestDrift reports missing when a captured resource no longer exists', async () => {
    deleteFunction(functionId);
    const drift = await projectService.getManifestDrift(projectId, userId);
    assert.ok(drift.missing.some((m) => m.kind === 'functions' && m.ref === 'my-function'));
  });

  it('unlinkResource strips the resource from the stored manifest', async () => {
    const fn2 = createFunction('fn-test-2', 'second-function', 'node20', 'export default () => {}', '', null, userId, projectId);

    await projectService.captureManifest(projectId, userId);
    let manifest = projectService.getManifest(projectId, userId);
    assert.ok(Object.values(manifest.functions).some((f) => f.id === fn2.id));

    await projectService.unlinkResource(projectId, userId, 'functions', fn2.id);
    manifest = projectService.getManifest(projectId, userId);
    assert.equal(Object.values(manifest.functions).some((f) => f.id === fn2.id), false);
    assert.equal(projectService.isResourceProtected('functions', fn2.id).protected, false);
  });
});
