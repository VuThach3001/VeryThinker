import { existsSync, statSync } from 'node:fs';
import { basename, dirname, delimiter, isAbsolute, join, resolve } from 'node:path';

export interface ExecutableCommand {
  executable: string;
  args: string[];
  resolved_via: 'direct' | 'node-npm-cli';
}

/** Preserve the reviewed argv while launching npm without a Windows command shell. */
export function resolveExecutableCommand(
  command: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; execPath?: string } = {},
): ExecutableCommand {
  if (!command.length || command.some((part) => typeof part !== 'string') || !command[0])
    throw new Error('A verification command requires an executable and argument array.');
  const platform = options.platform ?? process.platform;
  const executable = command[0];
  const name = basename(executable).toLowerCase();
  if (platform !== 'win32' || !['npm', 'npm.cmd'].includes(name))
    return { executable, args: command.slice(1), resolved_via: 'direct' };
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const explicit = isAbsolute(executable) || /[\\/]/.test(executable);
  const pathEntries = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .map((path) => path.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const candidates = explicit
    ? [join(dirname(resolve(executable)), 'node_modules/npm/bin/npm-cli.js')]
    : [
        env.npm_execpath,
        join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
        ...pathEntries.map((path) => join(path, 'node_modules/npm/bin/npm-cli.js')),
      ];
  const npmCli = candidates.find((path): path is string => {
    if (!path || basename(path).toLowerCase() !== 'npm-cli.js') return false;
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  });
  if (!npmCli)
    throw new Error(
      'Windows npm verification requires an installed npm-cli.js; repair the local Node/npm installation. Shell fallback is disabled.',
    );
  return {
    executable: execPath,
    args: [resolve(npmCli), ...command.slice(1)],
    resolved_via: 'node-npm-cli',
  };
}
