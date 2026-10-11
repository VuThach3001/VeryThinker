import {
  createCornellNote,
  reviseCornellNote,
  validateCornellNote,
  type CornellInput,
} from './notes.js';
import {
  listRecipes,
  prepareRecipe,
  resolveRecipe,
  reviseRecipe,
  runRecipe,
  type RecipeInput,
} from './recipes.js';
import { describeCapabilities, invokeCapability, resolveCapabilities } from './tools.js';

/** Internal CLI dispatcher; the caller parses --data once and prints the returned value. */
export async function dispatchKnowledgeCommand(
  root: string,
  group: string,
  command: string | undefined,
  args: string[],
  data: Record<string, unknown> = {},
): Promise<{ handled: boolean; result?: unknown }> {
  const id = args[0];
  if (group === 'note' || group === 'cornell') {
    if (command === 'create')
      return { handled: true, result: createCornellNote(root, data as unknown as CornellInput) };
    if (command === 'validate' && id)
      return { handled: true, result: validateCornellNote(root, id) };
    if (command === 'revise' && id)
      return {
        handled: true,
        result: reviseCornellNote(
          root,
          id,
          data.note as CornellInput,
          Number(data.expected_revision),
          String(data.revision_reason ?? ''),
        ),
      };
    throw new Error(
      'Use note create --data JSON, note revise ID --data JSON, or note validate KNOWLEDGE_ID.',
    );
  }
  if (group === 'recipe') {
    if (command === 'list') return { handled: true, result: listRecipes() };
    if (command === 'resolve' && id)
      return {
        handled: true,
        result: resolveRecipe(id, typeof data.version === 'string' ? data.version : undefined),
      };
    if (command === 'prepare')
      return { handled: true, result: prepareRecipe(root, data as unknown as RecipeInput) };
    if (command === 'run' && id)
      return {
        handled: true,
        result: runRecipe(
          root,
          id,
          typeof data.invocation_id === 'string' ? data.invocation_id : undefined,
        ),
      };
    if (command === 'revise' && id)
      return {
        handled: true,
        result: reviseRecipe(root, id, data as unknown as Parameters<typeof reviseRecipe>[2]),
      };
    throw new Error('Use recipe list|resolve ID|prepare --data JSON|run ID|revise ID --data JSON.');
  }
  if (group === 'capability' || group === 'tool') {
    if (command === 'describe')
      return {
        handled: true,
        result: describeCapabilities(root, String(data.role ?? id ?? 'manager')),
      };
    if (command === 'resolve')
      return {
        handled: true,
        result: await resolveCapabilities(
          root,
          data as unknown as Parameters<typeof resolveCapabilities>[1],
        ),
      };
    if (command === 'invoke')
      return {
        handled: true,
        result: await invokeCapability(
          root,
          data as unknown as Parameters<typeof invokeCapability>[1],
        ),
      };
    throw new Error('Use capability describe ROLE|resolve --data JSON|invoke --data JSON.');
  }
  return { handled: false };
}
