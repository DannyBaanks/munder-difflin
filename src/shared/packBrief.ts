/**
 * An Office Pack agent → what the hive needs to start it: a display name and
 * the job brief god sends to its inbox once it is live.
 *
 * The brief is adapted from dontbemichael's `teamMemberGoal` (Vivek Kumar, MIT)
 * and adds the pack's tool levels, so an imported pack's "ask first" cap
 * (capOutwardLevels) reaches the agent instead of stopping at the loader.
 * These are instructions, not enforcement: nothing in this fork compiles tool
 * levels into permissions yet.
 *
 * Pure, so the control channel and its tests share it.
 */
import type { AgentDefinitionV2 } from './agentDefinition';

/** "oscar" → "Oscar"; falls back to the role when a pack names no character. */
export function packAgentName(def: Pick<AgentDefinitionV2, 'id' | 'character' | 'role'>): string {
  const base = (def.character || def.id || def.role || 'agent').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function packBrief(
  def: Pick<AgentDefinitionV2, 'role' | 'summary' | 'does' | 'wontDo' | 'tools' | 'firstAction'>,
  pack: { displayName: string; imported: boolean }
): string {
  const ask = def.tools.filter((t) => t.level === 'ask').map((t) => t.capability);
  const off = def.tools.filter((t) => t.level === 'off').map((t) => t.capability);
  return [
    `You are the ${def.role} on this team (Office Pack: ${pack.displayName}). ${def.summary}`,
    def.does.length ? `\nWhat you do:\n${def.does.map((d) => `• ${d}`).join('\n')}` : '',
    def.wontDo.length ? `\nLeave these alone and ask the human first:\n${def.wontDo.map((d) => `• ${d}`).join('\n')}` : '',
    ask.length ? `\nAsk the human before using: ${ask.join(', ')}. Put the ask on the task card (humanQA) and wait for the answer.` : '',
    off.length ? `\nNever use: ${off.join(', ')}.` : '',
    pack.imported
      ? '\nThis pack came from outside the app, so everything that sends, posts, pays or deletes needs the human\'s approval first.'
      : '',
    def.firstAction ? `\nYour first job: ${def.firstAction}` : ''
  ].filter(Boolean).join('\n');
}
