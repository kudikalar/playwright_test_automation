/** Filesystem helpers for uploads, downloads and report artifacts. */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { PATHS } from '../constants/FrameworkConstants';
import { FrameworkError } from './FrameworkError';

/** Creates a directory (and parents) if it does not already exist. */
export function ensureDirectory(directory: string): string {
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    return directory;
  } catch (error) {
    throw new FrameworkError(
      'Unable to create directory',
      { operation: 'ensureDirectory', target: directory },
      error,
    );
  }
}

export function ensureFrameworkDirectories(directories: readonly string[]): void {
  directories.forEach(ensureDirectory);
}

export function writeTextFile(filePath: string, contents: string): string {
  ensureDirectory(dirname(filePath));
  try {
    writeFileSync(filePath, contents, 'utf8');
    return filePath;
  } catch (error) {
    throw new FrameworkError(
      'Unable to write file',
      { operation: 'writeTextFile', target: filePath },
      error,
    );
  }
}

export function writeJsonFile(filePath: string, contents: unknown): string {
  return writeTextFile(filePath, `${JSON.stringify(contents, undefined, 2)}\n`);
}

export function readTextFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new FrameworkError('File not found', { operation: 'readTextFile', target: filePath });
  }
  return readFileSync(filePath, 'utf8');
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function fileSizeBytes(filePath: string): number {
  if (!existsSync(filePath)) {
    throw new FrameworkError('File not found', { operation: 'fileSizeBytes', target: filePath });
  }
  return statSync(filePath).size;
}

/** Removes a file or directory tree, ignoring an already-absent target. */
export function remove(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    throw new FrameworkError('Unable to remove path', { operation: 'remove', target }, error);
  }
}

/** Lists files in a directory, optionally filtered by extension. */
export function listFiles(directory: string, extension?: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => (extension ? extname(file) === extension : true))
    .map((file) => join(directory, file));
}

/**
 * Creates a throwaway upload fixture on disk and returns its path.
 * Used by upload tests so no binary needs to be committed to the repository.
 */
export function createUploadFixture(
  fileName: string,
  contents = 'automation upload fixture',
): string {
  const target = resolve(ensureDirectory(PATHS.uploads), fileName);
  writeTextFile(target, contents);
  return target;
}

/** Parses a CSV export into rows of trimmed cells (quoted commas are not expected in exports). */
export function parseCsv(contents: string): string[][] {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

/** Streams a buffer to disk under `reports/downloads`, returning the absolute path. */
export function saveDownload(fileName: string, data: Buffer | string): Promise<string> {
  const target = resolve(ensureDirectory(PATHS.downloads), basename(fileName));
  return new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(target);
    stream.on('error', (error) =>
      rejectPromise(
        new FrameworkError('Unable to save download', { operation: 'saveDownload', target }, error),
      ),
    );
    stream.on('finish', () => resolvePromise(target));
    stream.end(data);
  });
}
