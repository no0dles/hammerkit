import { DefinitionGraph } from './definitions'
import { Principal } from './oauth'
import { matches } from './policy'
import { ApprovalRule } from './server-config'

// `*` stands for any characters, the rest has to match as written
export function matchesPattern(pattern: string, name: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${expression}$`).test(name)
}

// What a run executes: the tasks it names and everything they need first. A run
// that names none (it selects by labels) may execute any of them.
export function executedBy(graph: DefinitionGraph, tasks: string[]): string[] {
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) {
      return
    }
    seen.add(name)
    for (const dependency of graph[name]?.depends ?? []) {
      visit(dependency)
    }
  }
  for (const name of tasks.length > 0 ? tasks : Object.keys(graph)) {
    visit(name)
  }
  return [...seen]
}

function labelled(rule: ApprovalRule, labels: { [key: string]: string[] }): boolean {
  return Object.entries(rule.labels ?? {}).some(([key, wanted]) =>
    (Array.isArray(wanted) ? wanted : [wanted]).some((value) => (labels[key] ?? []).includes(value))
  )
}

// The rules a run falls under, by their position in the config: it uses one of the
// accounts of a rule, or executes a task it names or labels.
export function rulesFor(
  rules: ApprovalRule[],
  graph: DefinitionGraph,
  tasks: string[],
  account: string | null
): number[] {
  const executed = executedBy(graph, tasks)
  const matched: number[] = []
  rules.forEach((rule, index) => {
    const usesAccount = account !== null && (rule.accounts ?? []).some((pattern) => matchesPattern(pattern, account))
    const hit =
      usesAccount ||
      executed.some(
        (name) =>
          (rule.tasks ?? []).some((pattern) => matchesPattern(pattern, name)) ||
          labelled(rule, graph[name]?.labels ?? {})
      )
    if (hit) {
      matched.push(index)
    }
  })
  return matched
}

export function isApprover(rule: ApprovalRule, principal: Principal): boolean {
  return rule.approvers.some((approver) => matches(approver, principal))
}

// Whoever approves anything, for what they are shown and may read.
export function approvesAnything(rules: ApprovalRule[], principal: Principal): boolean {
  return rules.some((rule) => isApprover(rule, principal))
}
