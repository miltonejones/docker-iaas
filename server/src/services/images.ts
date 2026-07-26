import { docker } from '../docker.js';

export async function list() {
  const images = await docker.listImages();
  return images.map((img) => ({
    id: img.Id,
    tags: img.RepoTags || [],
    size: img.Size,
    created: img.Created,
  }));
}

export async function remove(id: string, force?: boolean) {
  await docker.getImage(id).remove({ force: !!force });
}

export async function prune() {
  const [imgResult, containerResult] = await Promise.all([
    docker.pruneImages(),
    docker.pruneContainers(),
  ]);
  return {
    ok: true as const,
    reclaimedBytes:
      (imgResult.SpaceReclaimed || 0) + (containerResult.SpaceReclaimed || 0),
  };
}
