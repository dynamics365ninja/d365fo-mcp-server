/**
 * Knowledge-base feedback channel (docs/AGENT_EVAL_LOOP.md §9, "Self-improving
 * upgrades"). VM-free.
 *
 * MODEL_ERROR clusters are NOT tool defects — `clusterRuns()` deliberately
 * excludes them from the actionable (code-fix) set. But a recurring
 * MODEL_ERROR is still signal: if the same mistake shows up across multiple
 * runs, the agent is plausibly missing (or being misled by) a rule that
 * belongs in the X++ knowledge base (`src/tools/xppKnowledge.ts`), not a tool
 * bug. This module clusters MODEL_ERROR runs the same way the code-fix path
 * clusters TOOL_DEFECT/KNOWLEDGE_GAP/VALIDATOR_GAP runs, then proposes which
 * existing knowledge topic (by keyword overlap) is the best edit target — or
 * flags that no existing topic matches, meaning a new one is needed.
 *
 * This module only PROPOSES; it never edits xppKnowledge.ts itself — unlike a
 * code fix (which is mechanically verifiable via a regression test), an
 * instruction/knowledge edit changes agent *behaviour* and needs a human (or
 * the improver agent, with explicit review) to judge whether the proposed
 * rule is actually correct before it lands.
 */

import { clusterRuns, type CorpusRun, type Cluster } from './cluster.js';

export interface KnowledgeEntryLike {
  id: string;
  title: string;
  keywords: string[];
}

export interface KnowledgeProposal {
  cluster: Cluster;
  /** Best-matching existing topic, or null if nothing scored above zero. */
  suggestedTopicId: string | null;
  suggestedTopicTitle: string | null;
  matchScore: number;
  /** True when no existing topic matched — this cluster likely needs a new entry. */
  isNewTopic: boolean;
}

/** MODEL_ERROR clusters, ranked the same way as the code-fix clusters (frequency × tier_weight). */
export function modelErrorClusters(runs: CorpusRun[]): Cluster[] {
  return clusterRuns(runs, true).filter(c => c.classification === 'MODEL_ERROR');
}

/** Tokenize free text into lowercase words of length > 2 (drops stopword-ish noise). */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
}

/**
 * Score a symptom string against one knowledge entry's keyword list: each
 * keyword that appears as a substring of a symptom token (or vice versa)
 * scores 1. Mirrors the simple substring-overlap approach xppKnowledge.ts's
 * own searchKnowledge() uses, so proposals are consistent with what a live
 * get_knowledge(topic=...) call would actually surface.
 */
export function scoreTopicMatch(symptom: string, entry: KnowledgeEntryLike): number {
  const words = tokenize(symptom);
  let score = 0;
  for (const kw of entry.keywords) {
    const kwLower = kw.toLowerCase();
    if (words.some(w => kwLower.includes(w) || w.includes(kwLower))) score += 1;
  }
  return score;
}

/** Best-matching knowledge entry for a symptom, or null if no entry scores above zero. */
export function suggestKnowledgeTopic(
  symptom: string,
  knowledgeBase: KnowledgeEntryLike[],
): { id: string; title: string; score: number } | null {
  let best: { id: string; title: string; score: number } | null = null;
  for (const entry of knowledgeBase) {
    const score = scoreTopicMatch(symptom, entry);
    if (score > 0 && (!best || score > best.score)) {
      best = { id: entry.id, title: entry.title, score };
    }
  }
  return best;
}

/** Build one proposal per MODEL_ERROR cluster, ranked by cluster priority. */
export function buildKnowledgeProposals(
  runs: CorpusRun[],
  knowledgeBase: KnowledgeEntryLike[],
): KnowledgeProposal[] {
  return modelErrorClusters(runs).map(cluster => {
    const match = suggestKnowledgeTopic(cluster.symptom, knowledgeBase);
    return {
      cluster,
      suggestedTopicId: match?.id ?? null,
      suggestedTopicTitle: match?.title ?? null,
      matchScore: match?.score ?? 0,
      isNewTopic: match === null,
    };
  });
}

/** Render proposals as a short, human-readable report. */
export function renderKnowledgeProposals(proposals: KnowledgeProposal[]): string {
  if (proposals.length === 0) return 'No MODEL_ERROR clusters — nothing to propose. 🎉';
  const lines: string[] = [`# Knowledge-base feedback proposals (${proposals.length})\n`];
  proposals.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.cluster.symptom}`);
    lines.push(`   freq=${p.cluster.frequency}  cases=${p.cluster.caseIds.join(', ')}`);
    if (p.isNewTopic) {
      lines.push(`   → no existing topic matched; likely needs a NEW xppKnowledge.ts entry`);
    } else {
      lines.push(`   → edit target: topic "${p.suggestedTopicId}" (${p.suggestedTopicTitle}), match score ${p.matchScore}`);
    }
  });
  return lines.join('\n');
}
