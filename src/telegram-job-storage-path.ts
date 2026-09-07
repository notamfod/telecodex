import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

interface FileIdentity { readonly realpath: string; readonly device: number | bigint; readonly inode: number | bigint; }
const MAX_SYMLINK_DEPTH = 40;

/** Detects planned SQLite artifacts and existing symlink/hardlink aliases without mutating either path. */
export function storagePathsAlias(candidatePath: string, databasePath: string): boolean {
  const candidate = path.resolve(candidatePath); const database = path.resolve(databasePath);
  const plannedCandidate = plannedRealPath(candidate); const realDatabase = plannedRealPath(database);
  if (!plannedCandidate || !realDatabase) return true;
  const artifacts = [database, `${database}-wal`, `${database}-shm`,
    ...(realDatabase !== database ? [realDatabase, `${realDatabase}-wal`, `${realDatabase}-shm`] : [])];
  if (artifacts.includes(candidate) || artifacts.includes(plannedCandidate)) return true;
  const candidateIdentity = identity(candidate);
  if (!candidateIdentity) return false;
  return artifacts.some((artifact) => {
    const artifactIdentity = identity(artifact);
    return artifactIdentity !== null && (artifactIdentity.realpath === candidateIdentity.realpath
      || (artifactIdentity.device === candidateIdentity.device && artifactIdentity.inode === candidateIdentity.inode));
  });
}

function plannedRealPath(filePath: string): string | null {
  let current = path.resolve(filePath); const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    if (seen.has(current)) return null; seen.add(current);
    const tail: string[] = []; let probe = current; let status: ReturnType<typeof lstatSync>;
    while (true) {
      try { status = lstatSync(probe); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "ENOENT" && code !== "ENOTDIR") || probe === path.dirname(probe)) return null;
        tail.unshift(path.basename(probe)); probe = path.dirname(probe);
      }
    }
    if (status.isSymbolicLink()) {
      current = path.resolve(path.dirname(probe), readlinkSync(probe), ...tail); continue;
    }
    try { return path.resolve(realpathSync.native(probe), ...tail); } catch { return null; }
  }
  return null;
}

function identity(filePath: string): FileIdentity | null {
  try {
    const status = statSync(filePath, { bigint: true });
    return { realpath: realpathSync.native(filePath), device: status.dev, inode: status.ino };
  } catch { return null; }
}
