import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig } from './config.mjs';

export async function main(args = process.argv.slice(2)) {
  const [command, file, payload] = args;
  if (!file || (command === 'get' && args.length !== 2) ||
      (command === 'set' && args.length !== 3) || !['get', 'set'].includes(command)) {
    throw new Error('Usage: node cli.mjs get <file> | set <file> <JSON>');
  }
  const result = command === 'get'
    ? await loadConfig(file)
    : await saveConfig(file, JSON.parse(payload));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
